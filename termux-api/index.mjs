import { randomBytes, timingSafeEqual } from 'node:crypto'
import { open, readFile, readdir, chmod, copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import P from 'pino'
import NodeCache from '@cacheable/node-cache'
import qrcode from 'qrcode-terminal'
import initSqlJs from 'sql.js'

import makeWASocket, {
	areJidsSameUser,
	DisconnectReason,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState
} from '../lib/index.js'

process.umask(0o077)

const appDir = dirname(fileURLToPath(import.meta.url))
const dataDir = join(appDir, 'data')
const authDir = join(appDir, 'auth')
const databasePath = join(dataDir, 'baileys.sqlite')
const databaseBackupPath = `${databasePath}.bak`
const tokenPath = join(dataDir, 'api-token.txt')
const lockPath = join(dataDir, 'process.lock')
const logger = P({
	level: process.env.LOG_LEVEL ?? 'warn',
	redact: ['*.auth', '*.creds', '*.qr', '*.phoneNumber', '*.authorization']
})

const numberFromEnv = (key, fallback, min, max) => {
	const value = Number.parseInt(process.env[key] ?? '', 10)
	return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

const config = {
	host: process.env.API_HOST ?? '127.0.0.1',
	port: numberFromEnv('API_PORT', 3000, 1, 65535),
	groupRefreshMs: numberFromEnv('GROUP_REFRESH_MS', 5 * 60_000, 30_000, 60 * 60_000),
	groupCacheMax: numberFromEnv('GROUP_CACHE_MAX', 100, 10, 500),
	groupCacheTtlMs: numberFromEnv('GROUP_CACHE_TTL_MS', 10 * 60_000, 30_000, 60 * 60_000),
	maxPageSize: numberFromEnv('API_MAX_PAGE_SIZE', 100, 10, 500),
	recentMessagesMax: numberFromEnv('RECENT_MESSAGES_MAX', 100, 0, 500),
	recentMessagesTtlMs: numberFromEnv('RECENT_MESSAGES_TTL_MS', 15 * 60_000, 60_000, 24 * 60 * 60_000),
	contactsMax: numberFromEnv('CONTACTS_MAX', 10_000, 100, 50_000),
	savedMessagesMax: numberFromEnv('SAVED_MESSAGES_MAX', 2_000, 100, 20_000),
	operationsMax: numberFromEnv('OPERATIONS_MAX', 1_000, 100, 10_000)
}
const pairingPhone = process.env.PAIRING_PHONE?.replace(/\D/g, '')
if (process.env.PAIRING_PHONE && !/^\d{8,15}$/.test(pairingPhone ?? '')) {
	throw new Error('PAIRING_PHONE deve conter de 8 a 15 dígitos com o código do país.')
}

let stopping = false
let socket
let connectionState = 'starting'
let reconnectAttempts = 0
let reconnectTimer
let groupRefreshTimer
let periodicGroupRefreshTimer
let contactsPersistTimer
let groupRefreshInFlight
let lastGroupRefreshAt = 0
let groupsInMemory = new Map()
const recentMessages = new Map()
let lockHandle
let database
let databaseWriteQueue = Promise.resolve()
const retryCounterCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 5 * 60 })
const startedAt = Date.now()

const sendJson = (response, status, value) => {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff'
	})
	response.end(JSON.stringify(value))
}

const sendError = (response, status, message) => sendJson(response, status, { error: message })

const ensurePrivateDirectory = async path => {
	await mkdir(path, { recursive: true, mode: 0o700 })
	await chmod(path, 0o700)
}

const secureExistingFiles = async path => {
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const entryPath = join(path, entry.name)
		if (entry.isDirectory()) {
			await chmod(entryPath, 0o700)
			await secureExistingFiles(entryPath)
		} else if (entry.isFile()) {
			await chmod(entryPath, 0o600)
		}
	}
}

const processIsAlive = pid => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error?.code === 'EPERM'
	}
}

const acquireProcessLock = async () => {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			lockHandle = await open(lockPath, 'wx', 0o600)
			await lockHandle.writeFile(`${process.pid}\n`)
			return
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error
			const priorPid = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10)
			if (!Number.isInteger(priorPid) || priorPid < 1) {
				throw new Error('O bloqueio da API existe, mas não contém um PID válido. Verifique se já há outra instância ativa.')
			}
			if (Number.isInteger(priorPid) && processIsAlive(priorPid)) {
				throw new Error(`A API já está ativa no processo ${priorPid}.`)
			}
			await unlink(lockPath).catch(() => {})
		}
	}
	throw new Error('Não foi possível adquirir o bloqueio de processo.')
}

const loadApiToken = async () => {
	if (process.env.API_TOKEN) {
		if (process.env.API_TOKEN.length < 32) {
			throw new Error('API_TOKEN deve ter pelo menos 32 caracteres.')
		}
		return process.env.API_TOKEN
	}

	try {
		const token = (await readFile(tokenPath, 'utf8')).trim()
		if (token.length < 32) throw new Error('O arquivo do token está inválido; defina API_TOKEN ou remova data/api-token.txt para gerar outro.')
		await chmod(tokenPath, 0o600)
		return token
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error
	}

	const token = randomBytes(32).toString('base64url')
	await writeFile(tokenPath, `${token}\n`, { flag: 'wx', mode: 0o600 })
	console.log('Token da API criado em data/api-token.txt; leia o arquivo localmente.')
	return token
}

const initDatabase = async () => {
	const require = createRequire(import.meta.url)
	const wasmDirectory = dirname(require.resolve('sql.js'))
	const SQL = await initSqlJs({ locateFile: file => join(wasmDirectory, file) })
	const bytes = await readFile(databasePath).catch(error => {
		if (error?.code === 'ENOENT') return undefined
		throw error
	})
	if (bytes) {
		try {
			database = new SQL.Database(bytes)
			await chmod(databasePath, 0o600)
		} catch (error) {
			const backup = await readFile(databaseBackupPath).catch(() => undefined)
			if (!backup) throw error
			await chmod(databaseBackupPath, 0o600)
			database = new SQL.Database(backup)
			await writeFile(databasePath, backup, { mode: 0o600 })
			logger.warn({ err: error }, 'Recovered SQLite snapshot from backup')
		}
	} else {
		database = new SQL.Database()
	}
	database.run(`
		CREATE TABLE IF NOT EXISTS groups (
			id TEXT PRIMARY KEY,
			subject TEXT NOT NULL,
			participant_count INTEGER NOT NULL,
			account_role TEXT NOT NULL,
			creation INTEGER,
			is_community INTEGER NOT NULL DEFAULT 0,
			announce INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)
	`)
	database.run('CREATE INDEX IF NOT EXISTS groups_subject_idx ON groups(subject COLLATE NOCASE)')
	database.run(`
		CREATE TABLE IF NOT EXISTS contacts (
			id TEXT PRIMARY KEY,
			name TEXT,
			notify TEXT,
			phone_number TEXT,
			updated_at TEXT NOT NULL
		)
	`)
	database.run('CREATE INDEX IF NOT EXISTS contacts_name_idx ON contacts(name COLLATE NOCASE)')
	database.run(`
		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			chat_id TEXT NOT NULL,
			sender_id TEXT,
			text TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			from_me INTEGER NOT NULL DEFAULT 0,
			selected_at TEXT NOT NULL
		)
	`)
	database.run('CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages(timestamp DESC)')
	database.run(`
		CREATE TABLE IF NOT EXISTS operations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL,
			detail TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`)
	const latestTimestamp = database.exec('SELECT MAX(updated_at) FROM groups')[0]?.values[0]?.[0]
	if (typeof latestTimestamp === 'string') lastGroupRefreshAt = Date.parse(latestTimestamp) || 0
}

const persistDatabase = () => {
	databaseWriteQueue = databaseWriteQueue.catch(() => {}).then(async () => {
		const temporaryPath = `${databasePath}.tmp`
		await copyFile(databasePath, databaseBackupPath).catch(error => {
			if (error?.code !== 'ENOENT') throw error
		})
		await chmod(databaseBackupPath, 0o600).catch(error => {
			if (error?.code !== 'ENOENT') throw error
		})
		await writeFile(temporaryPath, Buffer.from(database.export()), { mode: 0o600 })
		await rename(temporaryPath, databasePath)
	})
	return databaseWriteQueue
}

const recordOperation = (type, detail = {}) => {
	database.run('INSERT INTO operations (type, detail, created_at) VALUES (?, ?, ?)', [
		type,
		JSON.stringify(detail),
		new Date().toISOString()
	])
	database.run(
		'DELETE FROM operations WHERE id IN (SELECT id FROM operations ORDER BY id DESC LIMIT -1 OFFSET ?)',
		[config.operationsMax]
	)
}


const roleForAccount = (metadata, accountContact) => {
	const accountIds = [accountContact?.id, accountContact?.lid, accountContact?.phoneNumber].filter(Boolean)
	const participant = metadata.participants?.find(candidate => {
		return candidate.id && accountIds.some(accountId => areJidsSameUser(candidate.id, accountId))
	})
	if (!participant) return 'unknown'
	if (participant.admin === 'superadmin' || participant.isSuperAdmin) return 'superadmin'
	if (participant.admin === 'admin' || participant.isAdmin) return 'admin'
	return 'member'
}

const simplifyGroup = (metadata, accountContact, timestamp) => ({
	id: metadata.id,
	name: metadata.subject || '(sem nome)',
	participants: Number.isFinite(metadata.size) ? metadata.size : metadata.participants?.length ?? 0,
	accountRole: roleForAccount(metadata, accountContact),
	createdAt: metadata.creation ?? null,
	isCommunity: Boolean(metadata.isCommunity),
	adminsOnly: Boolean(metadata.announce),
	updatedAt: timestamp
})

const saveContacts = async (contacts, { persist = true } = {}) => {
	if (!Array.isArray(contacts) || contacts.length === 0) return 0
	const timestamp = new Date().toISOString()
	const rows = contacts.flatMap(contact => {
		const id = contact.id ?? contact.lid ?? contact.phoneNumber
		if (typeof id !== 'string' || id.length === 0) return []
		return [{
			id,
			name: typeof contact.name === 'string' ? contact.name : null,
			notify: typeof contact.notify === 'string' ? contact.notify : null,
			phoneNumber: typeof contact.phoneNumber === 'string' ? contact.phoneNumber : null
		}]
	})
	if (rows.length === 0) return 0

	database.run('BEGIN TRANSACTION')
	try {
		const statement = database.prepare(`
			INSERT INTO contacts (id, name, notify, phone_number, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name = COALESCE(excluded.name, contacts.name),
				notify = COALESCE(excluded.notify, contacts.notify),
				phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
				updated_at = excluded.updated_at
		`)
		for (const contact of rows) {
			statement.run([contact.id, contact.name, contact.notify, contact.phoneNumber, timestamp])
		}
		statement.free()
		database.run(
			'DELETE FROM contacts WHERE id IN (SELECT id FROM contacts ORDER BY updated_at DESC, id ASC LIMIT -1 OFFSET ?)',
			[config.contactsMax]
		)
		recordOperation('contacts_upsert', { count: rows.length })
		database.run('COMMIT')
	} catch (error) {
		database.run('ROLLBACK')
		throw error
	}
	if (persist) await persistDatabase()
	return rows.length
}

const scheduleContactsPersist = () => {
	clearTimeout(contactsPersistTimer)
	contactsPersistTimer = setTimeout(() => {
		contactsPersistTimer = undefined
		void persistDatabase().catch(error => logger.warn({ err: error }, 'Could not persist contact changes'))
	}, 1_500)
	contactsPersistTimer.unref?.()
}

const textFromMessage = message => {
	let content = message.message
	for (let depth = 0; depth < 5; depth += 1) {
		const wrapped = content?.ephemeralMessage?.message ??
			content?.viewOnceMessage?.message ??
			content?.viewOnceMessageV2?.message ??
			content?.documentWithCaptionMessage?.message
		if (!wrapped) break
		content = wrapped
	}
	return content?.conversation ??
		content?.extendedTextMessage?.text ??
		content?.imageMessage?.caption ??
		content?.videoMessage?.caption ??
		content?.documentMessage?.caption ??
		content?.buttonsResponseMessage?.selectedDisplayText ??
		content?.listResponseMessage?.title ??
		content?.templateButtonReplyMessage?.selectedDisplayText
}

const pruneRecentMessages = () => {
	const cutoff = Date.now() - config.recentMessagesTtlMs
	for (const [id, message] of recentMessages) {
		if (message.receivedAt < cutoff) recentMessages.delete(id)
	}
}

const rememberIncomingMessages = upsert => {
	if (config.recentMessagesMax === 0 || upsert.type !== 'notify') return
	pruneRecentMessages()
	for (const message of upsert.messages) {
		const id = message.key.id
		const chatId = message.key.remoteJid
		const text = textFromMessage(message)
		if (!id || !chatId || typeof text !== 'string' || text.length === 0) continue
		const rawTimestamp = message.messageTimestamp
		const timestamp = typeof rawTimestamp === 'object' && rawTimestamp && typeof rawTimestamp.toNumber === 'function'
			? rawTimestamp.toNumber()
			: Number(rawTimestamp ?? Math.floor(Date.now() / 1000))
		recentMessages.delete(id)
		recentMessages.set(id, {
			id,
			chatId,
			senderId: message.key.participant ?? chatId,
			text: text.slice(0, 4_000),
			timestamp: Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000),
			fromMe: Boolean(message.key.fromMe),
			receivedAt: Date.now()
		})
	}
	while (recentMessages.size > config.recentMessagesMax) {
		recentMessages.delete(recentMessages.keys().next().value)
	}
}

const selectRecentMessage = async id => {
	pruneRecentMessages()
	const message = recentMessages.get(id)
	if (!message) {
		const error = new Error('A mensagem não está mais na janela de seleção em memória.')
		error.statusCode = 404
		throw error
	}
	const selectedAt = new Date().toISOString()
	database.run('BEGIN TRANSACTION')
	try {
		database.run(`
			INSERT OR REPLACE INTO messages
			(id, chat_id, sender_id, text, timestamp, from_me, selected_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`, [message.id, message.chatId, message.senderId, message.text, message.timestamp, message.fromMe ? 1 : 0, selectedAt])
		database.run(
			'DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY selected_at DESC LIMIT -1 OFFSET ?)',
			[config.savedMessagesMax]
		)
		recordOperation('message_selected', {})
		database.run('COMMIT')
	} catch (error) {
		database.run('ROLLBACK')
		throw error
	}
	await persistDatabase()
	return { id: message.id, selectedAt }
}

const cacheGroupMetadata = (id, metadata) => {
	groupsInMemory.delete(id)
	groupsInMemory.set(id, { metadata, expiresAt: Date.now() + config.groupCacheTtlMs })
	while (groupsInMemory.size > config.groupCacheMax) {
		groupsInMemory.delete(groupsInMemory.keys().next().value)
	}
}

const getCachedGroupMetadata = async id => {
	const entry = groupsInMemory.get(id)
	if (!entry) return undefined
	if (entry.expiresAt <= Date.now()) {
		groupsInMemory.delete(id)
		return undefined
	}
	groupsInMemory.delete(id)
	groupsInMemory.set(id, entry)
	return entry.metadata
}

const refreshGroups = async ({ allowCooldown = true } = {}) => {
	if (groupRefreshInFlight) return groupRefreshInFlight
	if (!socket || connectionState !== 'open') throw new Error('WhatsApp ainda não está conectado.')
	const now = Date.now()
	if (allowCooldown && now - lastGroupRefreshAt < config.groupRefreshMs) {
		const retryAfter = Math.ceil((config.groupRefreshMs - (now - lastGroupRefreshAt)) / 1000)
		const error = new Error(`Aguarde ${retryAfter} segundos antes de atualizar os grupos novamente.`)
		error.statusCode = 429
		throw error
	}

	const activeSocket = socket
	groupRefreshInFlight = (async () => {
		const allGroups = await activeSocket.groupFetchAllParticipating()
		if (socket !== activeSocket) throw new Error('A conexão mudou durante a consulta dos grupos.')
		const timestamp = new Date().toISOString()
		const normalized = Object.values(allGroups).map(group => simplifyGroup(group, activeSocket.user, timestamp))

		database.run('BEGIN TRANSACTION')
		try {
			database.run('DELETE FROM groups')
			recordOperation('groups_refresh', { count: normalized.length })
			const statement = database.prepare(`
				INSERT OR REPLACE INTO groups
				(id, subject, participant_count, account_role, creation, is_community, announce, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)
			for (const group of normalized) {
				statement.run([
					group.id,
					group.name,
					group.participants,
					group.accountRole,
					group.createdAt,
					group.isCommunity ? 1 : 0,
					group.adminsOnly ? 1 : 0,
					group.updatedAt
				])
			}
			statement.free()
			database.run('COMMIT')
			groupsInMemory.clear()
			for (const group of Object.values(allGroups)) cacheGroupMetadata(group.id, group)
		} catch (error) {
			database.run('ROLLBACK')
			throw error
		}

		await persistDatabase()
		lastGroupRefreshAt = Date.now()
		logger.info({ count: normalized.length }, 'Group snapshot refreshed')
		return { count: normalized.length, updatedAt: timestamp }
	})().finally(() => {
		groupRefreshInFlight = undefined
	})

	return groupRefreshInFlight
}

const scheduleGroupRefresh = delayMs => {
	clearTimeout(groupRefreshTimer)
	groupRefreshTimer = setTimeout(() => {
		refreshGroups().catch(error => {
			if (error?.statusCode !== 429) logger.warn({ err: error }, 'Group refresh deferred')
		})
	}, delayMs)
	groupRefreshTimer.unref?.()
}

const readGroups = ({ search, role, community, sort, order, limit, offset }) => {
	const sortColumns = {
		name: 'subject COLLATE NOCASE',
		participants: 'participant_count',
		updated: 'updated_at'
	}
	const orderSql = order === 'desc' ? 'DESC' : 'ASC'
	const sortSql = sortColumns[sort] ?? sortColumns.name
	const filters = []
	const parameters = []
	if (search) {
		const slash = String.fromCharCode(92)
		const escapedSearch = search.split(slash).join(slash + slash).split('%').join(slash + '%').split('_').join(slash + '_')
		filters.push('subject LIKE ? ESCAPE char(92)')
		parameters.push(`%${escapedSearch}%`)
	}
	if (['admin', 'superadmin', 'member', 'unknown'].includes(role)) {
		filters.push('account_role = ?')
		parameters.push(role)
	}
	if (community === 'true' || community === 'false') {
		filters.push('is_community = ?')
		parameters.push(community === 'true' ? 1 : 0)
	}
	const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
	const countStatement = database.prepare(`SELECT COUNT(*) AS total FROM groups ${where}`, parameters)
	const total = countStatement.step() ? countStatement.getAsObject().total : 0
	countStatement.free()
	const statement = database.prepare(
		`SELECT id, subject AS name, participant_count AS participants, account_role AS accountRole,
		creation AS createdAt, is_community AS isCommunity, announce AS adminsOnly, updated_at AS updatedAt
		FROM groups ${where} ORDER BY ${sortSql} ${orderSql}, id ASC LIMIT ? OFFSET ?`,
		[...parameters, limit, offset]
	)
	const groups = []
	while (statement.step()) {
		const group = statement.getAsObject()
		group.isCommunity = Boolean(group.isCommunity)
		group.adminsOnly = Boolean(group.adminsOnly)
		groups.push(group)
	}
	statement.free()
	return { total, groups }
}

const readAllGroups = () => {
	const statement = database.prepare(`
		SELECT id, subject AS name, participant_count AS participants, account_role AS accountRole,
		creation AS createdAt, is_community AS isCommunity, announce AS adminsOnly, updated_at AS updatedAt
		FROM groups ORDER BY subject COLLATE NOCASE, id
	`)
	const groups = []
	while (statement.step()) {
		const group = statement.getAsObject()
		group.isCommunity = Boolean(group.isCommunity)
		group.adminsOnly = Boolean(group.adminsOnly)
		groups.push(group)
	}
	statement.free()
	return groups
}

const readContacts = ({ search, limit, offset }) => {
	const where = search
		? "WHERE instr(lower(coalesce(name, '')), lower(?)) > 0 OR instr(lower(coalesce(notify, '')), lower(?)) > 0 OR instr(lower(coalesce(phone_number, '')), lower(?)) > 0 OR instr(lower(id), lower(?)) > 0"
		: ''
	const parameters = search ? [search, search, search, search] : []
	const countStatement = database.prepare(`SELECT COUNT(*) AS total FROM contacts ${where}`, parameters)
	const total = countStatement.step() ? countStatement.getAsObject().total : 0
	countStatement.free()
	const statement = database.prepare(`
		SELECT id, COALESCE(name, notify, phone_number, id) AS name, notify, phone_number AS phoneNumber, updated_at AS updatedAt
		FROM contacts ${where} ORDER BY COALESCE(name, notify, phone_number, id) COLLATE NOCASE, id
		LIMIT ? OFFSET ?
	`, [...parameters, limit, offset])
	const contacts = []
	while (statement.step()) contacts.push(statement.getAsObject())
	statement.free()
	return { total, contacts }
}

const readAllContacts = () => {
	const statement = database.prepare(`
		SELECT id, COALESCE(name, notify, phone_number, id) AS name, notify, phone_number AS phoneNumber, updated_at AS updatedAt
		FROM contacts ORDER BY COALESCE(name, notify, phone_number, id) COLLATE NOCASE, id
	`)
	const contacts = []
	while (statement.step()) contacts.push(statement.getAsObject())
	statement.free()
	return contacts
}

const readSavedMessages = ({ limit, offset }) => {
	const total = Number(database.exec('SELECT COUNT(*) FROM messages')[0]?.values[0]?.[0] ?? 0)
	const statement = database.prepare(`
		SELECT id, chat_id AS chatId, sender_id AS senderId, text, timestamp, from_me AS fromMe, selected_at AS selectedAt
		FROM messages ORDER BY timestamp DESC, selected_at DESC LIMIT ? OFFSET ?
	`, [limit, offset])
	const messages = []
	while (statement.step()) {
		const message = statement.getAsObject()
		message.fromMe = Boolean(message.fromMe)
		messages.push(message)
	}
	statement.free()
	return { total, messages }
}

const readOperations = limit => {
	const statement = database.prepare(`
		SELECT id, type, detail, created_at AS createdAt FROM operations ORDER BY id DESC LIMIT ?
	`, [limit])
	const operations = []
	while (statement.step()) {
		const operation = statement.getAsObject()
		operation.detail = JSON.parse(operation.detail)
		operations.push(operation)
	}
	statement.free()
	return operations
}

const readJsonBody = async request => {
	let body = ''
	for await (const chunk of request) {
		body += chunk
		if (Buffer.byteLength(body) > 4_096) {
			const error = new Error('Corpo JSON excede 4 KB.')
			error.statusCode = 413
			throw error
		}
	}
	if (!body) return {}
	try {
		return JSON.parse(body)
	} catch {
		const error = new Error('JSON inválido.')
		error.statusCode = 400
		throw error
	}
}

const authenticate = (request, token) => {
	const supplied = request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1]
	if (!supplied) return false
	const suppliedBytes = Buffer.from(supplied)
	const expectedBytes = Buffer.from(token)
	if (suppliedBytes.length !== expectedBytes.length) return false
	return timingSafeEqual(suppliedBytes, expectedBytes)
}

const csvCell = value => {
	let safeValue = String(value ?? '')
	if (/^[=+\-@]/.test(safeValue)) safeValue = `'${safeValue}`
	return `"${safeValue.replace(/"/g, '""')}"`
}

const createApiServer = token => createServer(async (request, response) => {
	try {
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
	if (request.method === 'GET' && url.pathname === '/health') {
		return sendJson(response, 200, { ok: true, connection: connectionState })
	}
	if (!authenticate(request, token)) return sendError(response, 401, 'Token ausente ou inválido.')
	if (request.method === 'GET' && url.pathname === '/api/status') {
		return sendJson(response, 200, {
			connection: connectionState,
			reconnectAttempts,
			groups: Number(database.exec('SELECT COUNT(*) AS count FROM groups')[0]?.values[0]?.[0] ?? 0),
			contacts: Number(database.exec('SELECT COUNT(*) FROM contacts')[0]?.values[0]?.[0] ?? 0),
			savedMessages: Number(database.exec('SELECT COUNT(*) FROM messages')[0]?.values[0]?.[0] ?? 0),
			recentMessagesInMemory: recentMessages.size,
			groupsUpdatedAt: lastGroupRefreshAt ? new Date(lastGroupRefreshAt).toISOString() : null,
			uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
			memoryRssBytes: process.memoryUsage().rss
		})
	}
	if (request.method === 'GET' && url.pathname === '/api/contacts/export') {
		const contacts = readAllContacts()
		if (url.searchParams.get('format') === 'csv') {
			const columns = ['id', 'name', 'notify', 'phoneNumber', 'updatedAt']
			const lines = [columns.join(','), ...contacts.map(contact => columns.map(column => csvCell(contact[column])).join(','))]
			response.writeHead(200, {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': 'attachment; filename="contatos.csv"',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff'
			})
			response.end(`\uFEFF${lines.join('\r\n')}`)
			return
		}
		return sendJson(response, 200, { count: contacts.length, contacts })
	}
	if (request.method === 'GET' && url.pathname === '/api/contacts') {
		const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
		const requestedOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
		const limit = Number.isFinite(requestedLimit) ? Math.min(config.maxPageSize, Math.max(1, requestedLimit)) : 50
		const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0
		const result = readContacts({ search: (url.searchParams.get('search') ?? '').slice(0, 100), limit, offset })
		return sendJson(response, 200, { ...result, limit, offset })
	}
	if (request.method === 'GET' && url.pathname === '/api/messages/recent') {
		pruneRecentMessages()
		return sendJson(response, 200, { count: recentMessages.size, messages: [...recentMessages.values()].map(({ receivedAt, ...message }) => message) })
	}
	if (request.method === 'POST' && url.pathname === '/api/messages/select') {
		const body = await readJsonBody(request)
		if (typeof body.id !== 'string' || body.id.length === 0 || body.id.length > 256) {
			return sendError(response, 400, 'Informe um id de mensagem válido.')
		}
		return sendJson(response, 201, await selectRecentMessage(body.id))
	}
	if (request.method === 'GET' && url.pathname === '/api/messages/export') {
		const result = readSavedMessages({ limit: config.savedMessagesMax, offset: 0 })
		return sendJson(response, 200, { count: result.total, messages: result.messages })
	}
	if (request.method === 'GET' && url.pathname === '/api/messages/saved') {
		const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
		const requestedOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
		const limit = Number.isFinite(requestedLimit) ? Math.min(config.maxPageSize, Math.max(1, requestedLimit)) : 50
		const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0
		return sendJson(response, 200, { ...readSavedMessages({ limit, offset }), limit, offset })
	}
	if (request.method === 'DELETE' && url.pathname.startsWith('/api/messages/saved/')) {
		const messageId = decodeURIComponent(url.pathname.slice('/api/messages/saved/'.length))
		if (!messageId) return sendError(response, 400, 'Informe um id de mensagem válido.')
		database.run('DELETE FROM messages WHERE id = ?', [messageId])
		if (database.getRowsModified() === 0) return sendError(response, 404, 'Mensagem salva não encontrada.')
		recordOperation('message_deleted', {})
		await persistDatabase()
		return sendJson(response, 200, { deleted: true, id: messageId })
	}
	if (request.method === 'GET' && url.pathname === '/api/operations') {
		const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
		const limit = Number.isFinite(requestedLimit) ? Math.min(config.operationsMax, Math.max(1, requestedLimit)) : 100
		return sendJson(response, 200, { operations: readOperations(limit) })
	}
	if (request.method === 'GET' && url.pathname === '/api/groups/export') {
		const groups = readAllGroups()
		if (url.searchParams.get('format') === 'csv') {
			const columns = ['id', 'name', 'participants', 'accountRole', 'createdAt', 'isCommunity', 'adminsOnly', 'updatedAt']
			const lines = [columns.join(','), ...groups.map(group => columns.map(column => csvCell(group[column])).join(','))]
			response.writeHead(200, {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': 'attachment; filename="grupos.csv"',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff'
			})
			response.end(`\uFEFF${lines.join('\r\n')}`)
			return
		}
		return sendJson(response, 200, {
			count: groups.length,
			updatedAt: lastGroupRefreshAt ? new Date(lastGroupRefreshAt).toISOString() : null,
			groups
		})
	}
	if (request.method === 'GET' && url.pathname === '/api/groups') {
		const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
		const requestedOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
		const limit = Number.isFinite(requestedLimit) ? Math.min(config.maxPageSize, Math.max(1, requestedLimit)) : 50
		const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0
		const search = (url.searchParams.get('search') ?? '').slice(0, 100)
		const result = readGroups({
			search,
			role: url.searchParams.get('role'),
			community: url.searchParams.get('community'),
			sort: url.searchParams.get('sort'),
			order: url.searchParams.get('order'),
			limit,
			offset
		})
		return sendJson(response, 200, { ...result, limit, offset, updatedAt: lastGroupRefreshAt || null })
	}
	if (request.method === 'POST' && url.pathname === '/api/groups/refresh') {
		try {
			return sendJson(response, 200, await refreshGroups())
		} catch (error) {
			return sendError(response, error?.statusCode ?? 503, error?.message ?? 'Não foi possível atualizar os grupos.')
		}
	}
	if (request.method === 'GET' && url.pathname.startsWith('/api/groups/')) {
		const groupId = decodeURIComponent(url.pathname.slice('/api/groups/'.length))
		const statement = database.prepare(`
			SELECT id, subject AS name, participant_count AS participants, account_role AS accountRole,
			creation AS createdAt, is_community AS isCommunity, announce AS adminsOnly, updated_at AS updatedAt
			FROM groups WHERE id = ?
		`, [groupId])
		const found = statement.step() ? statement.getAsObject() : undefined
		statement.free()
		if (!found) return sendError(response, 404, 'Grupo não encontrado no último snapshot.')
		found.isCommunity = Boolean(found.isCommunity)
		found.adminsOnly = Boolean(found.adminsOnly)
		return sendJson(response, 200, found)
	}
	return sendError(response, 404, 'Rota não encontrada.')
	} catch (error) {
		logger.warn({ err: error }, 'API request failed')
		if (!response.headersSent) return sendError(response, 400, 'Solicitação inválida.')
		response.destroy()
	}
})

const reconnectDelayMs = () => {
	const base = Math.min(120_000, 1_000 * 2 ** Math.min(reconnectAttempts, 7))
	return Math.round(base * (0.8 + Math.random() * 0.4))
}

const scheduleReconnect = reason => {
	if (stopping || reconnectTimer) return
	reconnectAttempts += 1
	const delayMs = reconnectDelayMs()
	connectionState = 'reconnecting'
	logger.warn({ reason, attempt: reconnectAttempts, delayMs }, 'WhatsApp disconnected; reconnect scheduled')
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined
		connect().catch(error => {
			logger.error({ err: error }, 'Failed to start WhatsApp socket')
			scheduleReconnect('socket_start_failed')
		})
	}, delayMs)
	reconnectTimer.unref?.()
}

const connect = async () => {
	if (stopping) return
	connectionState = 'connecting'
	const { state, saveCreds } = await useMultiFileAuthState(authDir)
	await secureExistingFiles(authDir)
	const currentSocket = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger)
		},
		logger,
		syncFullHistory: false,
		markOnlineOnConnect: false,
		msgRetryCounterCache: retryCounterCache,
		cachedGroupMetadata: getCachedGroupMetadata
	})
	socket = currentSocket
	let pairingCodeRequested = false

	currentSocket.ev.on('creds.update', () => {
		void saveCreds().catch(error => logger.error({ err: error }, 'Failed to persist authentication state'))
	})
	currentSocket.ev.on('connection.update', update => {
		if (socket !== currentSocket || stopping) return
		if (update.qr) {
			connectionState = 'awaiting_qr'
			if (pairingPhone && !state.creds.registered && !pairingCodeRequested) {
				pairingCodeRequested = true
				currentSocket.requestPairingCode(pairingPhone)
					.then(code => console.log(`Código de vinculação do WhatsApp: ${code}`))
					.catch(error => {
						pairingCodeRequested = false
						logger.error({ err: error }, 'Could not request pairing code')
					})
			} else if (!state.creds.registered) {
				console.log('Escaneie o QR pelo WhatsApp > Aparelhos conectados:')
				qrcode.generate(update.qr, { small: true })
			}
		}
		if (update.connection === 'open') {
			connectionState = 'open'
			reconnectAttempts = 0
			logger.info('WhatsApp connected')
			scheduleGroupRefresh(2_000)
		}
		if (update.connection === 'close') {
			connectionState = 'closed'
			socket = undefined
			const reason = update.lastDisconnect?.error?.output?.statusCode
			if (reason === DisconnectReason.loggedOut) {
				connectionState = 'logged_out'
				logger.error('WhatsApp session logged out; remove termux-api/auth only if you want to pair again')
			} else {
				scheduleReconnect(reason ?? 'unknown')
			}
		}
	})
	currentSocket.ev.on('groups.update', () => scheduleGroupRefresh(5_000))
	currentSocket.ev.on('group-participants.update', () => scheduleGroupRefresh(5_000))
	currentSocket.ev.on('contacts.upsert', contacts => {
		void saveContacts(contacts, { persist: false }).then(count => { if (count) scheduleContactsPersist() })
			.catch(error => logger.warn({ err: error }, 'Could not persist contacts'))
	})
	currentSocket.ev.on('contacts.update', contacts => {
		void saveContacts(contacts, { persist: false }).then(count => { if (count) scheduleContactsPersist() })
			.catch(error => logger.warn({ err: error }, 'Could not update contacts'))
	})
	currentSocket.ev.on('messages.upsert', upsert => rememberIncomingMessages(upsert))
}

const shutdown = async signal => {
	if (stopping) return
	stopping = true
	connectionState = 'stopping'
	clearTimeout(reconnectTimer)
	clearTimeout(groupRefreshTimer)
	clearTimeout(contactsPersistTimer)
	clearInterval(periodicGroupRefreshTimer)
	logger.info({ signal }, 'Shutting down Termux API')
	const activeSocket = socket
	socket = undefined
	if (activeSocket) await activeSocket.end(undefined).catch(() => {})
	if (contactsPersistTimer) {
		contactsPersistTimer = undefined
		await persistDatabase().catch(error => logger.error({ err: error }, 'Could not flush contact changes'))
	}
	await databaseWriteQueue.catch(() => {})
	await new Promise(resolve => apiServer.close(() => resolve()))
	await lockHandle?.close()
	await unlink(lockPath).catch(() => {})
	database?.close()
	retryCounterCache.close()
	process.exit(0)
}

await ensurePrivateDirectory(dataDir)
await ensurePrivateDirectory(authDir)
await secureExistingFiles(authDir)
await acquireProcessLock()
await initDatabase()
const apiToken = await loadApiToken()
const apiServer = createApiServer(apiToken)
apiServer.on('error', error => {
	logger.error({ err: error }, 'HTTP API server failed')
	void shutdown('api_server_error')
})
apiServer.listen(config.port, config.host, () => {
	console.log(`API Baileys disponível em http://${config.host}:${config.port}`)
})
periodicGroupRefreshTimer = setInterval(() => {
	if (connectionState === 'open') {
		refreshGroups().catch(error => {
			if (error?.statusCode !== 429) logger.warn({ err: error }, 'Periodic group refresh failed')
		})
	}
}, config.groupRefreshMs)
periodicGroupRefreshTimer.unref?.()

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

connect().catch(error => {
	logger.error({ err: error }, 'Initial WhatsApp connection failed')
	scheduleReconnect('initial_connect_failed')
})
