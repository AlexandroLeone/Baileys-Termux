# API leve para Termux

Esta pasta acrescenta uma API HTTP local sobre a cópia do Baileys. Ela não usa Docker, PostgreSQL ou Redis. O servidor escuta em `127.0.0.1` por padrão.

## Instalação no Termux

```sh
pkg update
pkg install nodejs-lts git
node --version
```

Use Node.js 20 ou superior. Na pasta raiz do Baileys, instale e compile a biblioteca; depois instale as duas dependências leves da API:

```sh
corepack enable
yarn install --immutable
yarn build
cd termux-api
npm install
npm start
```

Se o Termux não tiver o Corepack, instale com `npm install -g corepack` e execute `corepack enable`. Na primeira execução, aparece um QR no terminal e a API cria `data/api-token.txt`. Leia o token localmente e guarde-o como uma credencial. O token não é disponibilizado por nenhum endpoint.

Para vincular pelo código numérico, defina `PAIRING_PHONE` com o número internacional contendo apenas dígitos antes de iniciar o processo. Exemplo: `PAIRING_PHONE=5511999999999 npm start`.

Para trocar o token gerado, pare o processo, remova `data/api-token.txt` e inicie a API novamente. Também é possível fornecer `API_TOKEN` pelo ambiente; esse valor tem prioridade.

## Rotas

Todas as rotas em `/api/` exigem o cabeçalho `Authorization: Bearer <token>`. `/health` fica sem autenticação para uma checagem local simples.

| Método e rota | Ação |
| --- | --- |
| `GET /health` | Estado básico do processo e da conexão. |
| `GET /api/status` | Conexão, tentativas de reconexão, totais de grupos, contatos e mensagens, tempo ativo e RAM. |
| `GET /api/groups` | Lista paginada; aceita `search`, `role=admin\|superadmin\|member\|unknown`, `community=true\|false`, `sort=name\|participants\|updated`, `order=asc\|desc`, `limit` e `offset`. |
| `GET /api/groups/<id>` | Consulta um grupo do snapshot local. Use URL encoding para o ID. |
| `GET /api/groups/export?format=json` | Exporta todos os grupos para JSON. |
| `GET /api/groups/export?format=csv` | Baixa CSV compatível com acentos e protegido contra fórmulas de planilha. |
| `POST /api/groups/refresh` | Consulta os grupos novamente no WhatsApp. Há intervalo mínimo de 5 minutos por padrão. |
| `GET /api/contacts?search=<texto>&limit=50&offset=0` | Pesquisa contatos armazenados localmente e retorna uma página. |
| `GET /api/contacts/export?format=json` ou `format=csv` | Exporta contatos para JSON ou CSV. |
| `GET /api/messages/recent` | Lista mensagens de texto recentes mantidas temporariamente em memória. |
| `POST /api/messages/select` | Salva uma mensagem recente escolhida; corpo JSON: `{"id":"ID_DA_MENSAGEM"}`. |
| `GET /api/messages/saved` | Lista mensagens selecionadas e persistidas, com paginação. |
| `GET /api/messages/export` | Exporta mensagens selecionadas em JSON. |
| `DELETE /api/messages/saved/<id>` | Apaga uma mensagem selecionada. Codifique o ID para uso em URL. |
| `GET /api/operations?limit=100` | Mostra o histórico limitado de operações locais. |

Exemplo no próprio Termux, a partir desta pasta:

```sh
TOKEN="$(cat data/api-token.txt)"
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/status
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3000/api/groups?sort=participants&order=desc"
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3000/api/groups/export?format=json"
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3000/api/contacts?search=Maria"
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3000/api/messages/recent"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"ID_DA_MENSAGEM"}' http://127.0.0.1:3000/api/messages/select
```

Para receber chamadas de outro dispositivo na mesma rede, defina `API_HOST=0.0.0.0` e restrinja o acesso pela rede local. O token continua obrigatório. A porta padrão é `3000`; altere com `API_PORT`.

| Variável | Padrão | Uso |
| --- | --- | --- |
| `API_HOST` | `127.0.0.1` | Interface de rede do servidor. |
| `API_PORT` | `3000` | Porta HTTP. |
| `API_TOKEN` | Token criado em arquivo | Sobrescreve o token local; exige pelo menos 32 caracteres. |
| `PAIRING_PHONE` | — | Número internacional só com dígitos para pedir código de vinculação. |
| `GROUP_REFRESH_MS` | `300000` | Intervalo de atualização automática e limite entre atualizações manuais. |
| `GROUP_CACHE_MAX` | `100` | Máximo de metadados completos mantidos em memória. |
| `GROUP_CACHE_TTL_MS` | `600000` | Tempo de vida do cache de metadados. |
| `API_MAX_PAGE_SIZE` | `100` | Limite máximo de grupos por página. |
| `RECENT_MESSAGES_MAX` | `100` | Quantidade máxima de mensagens de texto recentes em RAM; `0` desativa a captura. |
| `RECENT_MESSAGES_TTL_MS` | `900000` | Tempo de retenção temporária das mensagens recentes (1 minuto a 24 horas). |
| `CONTACTS_MAX` | `10000` | Limite de contatos guardados no SQLite. |
| `SAVED_MESSAGES_MAX` | `2000` | Limite de mensagens escolhidas guardadas no SQLite. |
| `OPERATIONS_MAX` | `1000` | Limite de registros no histórico de operações. |
| `LOG_LEVEL` | `warn` | Nível de log do Pino. |

## O que fica salvo

- `data/baileys.sqlite`: snapshot de grupos com ID, nome, quantidade de participantes, função da conta, data de criação e sinalizadores básicos.
- O mesmo SQLite guarda até `CONTACTS_MAX` contatos, mensagens escolhidas explicitamente e até `OPERATIONS_MAX` registros de operação.
- `data/baileys.sqlite.bak`: cópia do banco anterior à última atualização, usada se o arquivo principal estiver corrompido.
- `auth/`: credenciais necessárias para manter a sessão vinculada.
- `data/api-token.txt`: token de acesso à API, criado aleatoriamente na primeira execução.

As pastas `auth/` e `data/` são ignoradas pelo Git. O processo aplica permissões privadas no Termux e impede duas instâncias simultâneas. Por padrão, somente mensagens de texto recebidas ficam temporariamente em memória (até 100 por 15 minutos); nada é salvo no banco até uma mensagem ser escolhida pela rota de seleção. Anexos e o histórico completo não são armazenados. Contatos sincronizados são salvos no SQLite até o limite configurado. O cache em memória mantém até 100 metadados de grupo por 10 minutos.

## Reconexão e operação no Android

Quedas temporárias usam espera progressiva com variação aleatória, de cerca de 2 segundos até 2 minutos. Se o WhatsApp encerrar a sessão, a reconexão automática para e o estado fica `logged_out`; vincule a conta novamente depois de revisar a sessão local.

Para deixar o terminal ativo enquanto o Android permite:

```sh
pkg install termux-api tmux
termux-wake-lock
tmux new -s baileys
```

Inicie `npm start` dentro do `tmux`; para sair sem encerrar, use `Ctrl-B` e depois `D`. O bloqueio de suspensão reduz interrupções, mas o Android ainda pode encerrar processos em segundo plano conforme as configurações de bateria do aparelho. Esta camada foi preparada para Termux, mas a conexão precisa ser validada no aparelho e na versão de Node instalada nele.

Não exponha `auth/`, `data/api-token.txt`, QR ou código de vinculação. Quem obtiver as credenciais da pasta `auth/` pode assumir a sessão vinculada.
