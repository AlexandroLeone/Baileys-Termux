# Sua cópia do Baileys

Esta é uma cópia editável do código-fonte de [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys), criada a partir do commit `0af2386292907f7d9742d8d41f830d8c48208fa1` da branch `master`. A branch local `minha-versao` está pronta para receber suas mudanças. O histórico Git foi clonado de forma rasa (`--depth 1`); todos os arquivos da versão selecionada estão presentes.

A biblioteca continua com o nome interno `baileys` e a versão `7.0.0-rc14` para preservar os imports e o build originais. Acrescentei `termux-api/`, uma API HTTP para Termux com reconexão progressiva, consulta/exportação de grupos, pesquisa/exportação de contatos, seleção explícita de mensagens recentes, SQLite com cópia de segurança, histórico limitado de operações e autenticação por token. `.gitattributes` também mantém os arquivos de código em LF no Windows. O protocolo central do Baileys não foi alterado.

## O que existe no projeto

| Caminho | Finalidade |
| --- | --- |
| `src/Socket/` | Conexão e operações de mensagens, chats, grupos, comunidades e newsletters. |
| `src/Signal/` | Criptografia e estado das sessões Signal. |
| `src/Utils/` | Autenticação, mídia, sincronização e utilitários. |
| `src/Types/` | Tipos públicos da API. |
| `src/WABinary/` e `src/WAUSync/` | Codificação binária e consultas USync. |
| `src/Defaults/` | Configurações e constantes padrão. |
| `termux-api/` | Serviço HTTP local para Termux, persistência SQLite e instruções de operação. |
| `WAProto/` | Definições e código gerado de protobuf. |
| `Example/example.ts` | Exemplo oficial de conexão e eventos. |
| `src/__tests__/` | Testes unitários, de integração e testes e2e separados. |

O ponto de entrada público é `src/index.ts`. Mudanças em `src/Types/` ou nesse ponto de entrada podem alterar a API de quem usa a biblioteca. Mudanças em `src/Signal/`, na autenticação e no protocolo precisam de testes específicos. Os arquivos gerados em `WAProto/` não devem ser editados manualmente.

## Preparação

1. Instale Node.js 20 ou superior, com npm.
2. Ative o Corepack (`corepack enable`). Se ele não estiver disponível, instale-o com `npm install -g corepack` e depois ative-o.
3. Na pasta deste projeto, execute:

```powershell
yarn install --immutable
yarn build
yarn lint
```

O projeto fixa Yarn `4.9.2` em `package.json` e usa `nodeLinker: node-modules`. Evite gerar `yarn.lock` com Yarn 1 ou outro gerenciador.

No Windows, o script `yarn test` desta revisão aponta para um executável de shell Unix. Execute os testes unitários e de integração assim:

```powershell
node --experimental-vm-modules ./node_modules/jest/bin/jest.js --testMatch '**/*.test.ts'
```

Para experimentar a conexão, rode `yarn example` e acompanhe o código em `Example/example.ts`. O exemplo cria a pasta `baileys_auth_info/`, que contém credenciais de sessão. Essa pasta não deve ser compartilhada, compactada ou versionada.

## Como modificar

1. Escolha o comportamento desejado e localize a área na tabela acima.
2. Leia o módulo e os testes correspondentes antes de editar. As regras de estilo e contribuição estão em `AGENTS.md`.
3. Faça uma mudança pequena e adicione um teste quando houver comportamento novo ou correção de defeito.
4. Execute `yarn lint`, os testes pelo comando compatível com Windows acima e `yarn build`.
5. Confira `git diff` e crie um commit na branch `minha-versao`.

Se o objetivo for um bot ou uma integração específica, o caminho recomendado pelo próprio projeto é criar uma aplicação que importe Baileys, usando `Example/example.ts` como referência, sem alterar o núcleo do protocolo sem necessidade.

Para iniciar a API Termux, siga o passo a passo em [`termux-api/README.md`](termux-api/README.md). Ela expõe status, grupos, contatos, mensagens recentes/selecionadas e operações; oferece filtros e exportação. Por padrão, só aceita chamadas locais em `127.0.0.1` e exige token em todas as rotas `/api/`. Mensagens recebidas ficam em RAM por até 15 minutos e só são persistidas quando selecionadas; isso pode ser desativado com `RECENT_MESSAGES_MAX=0`.

## Observações sobre esta cópia

- Verificado em 21/10/2026: instalação com Yarn 4.9.2, `yarn build` e `yarn lint` concluídos. O lint terminou com 103 avisos preexistentes e nenhum erro.
- Antes da implementação da camada Termux, os testes unitários e de integração do núcleo passaram: 28 suítes e 407 testes. Esses resultados não cobrem a API nova; testes e2e e conexão real com WhatsApp não foram executados.
- A camada Termux requer Node.js 20+, Yarn para compilar o núcleo e npm para instalar `sql.js` e `qrcode-terminal`. A verificação sintática do Node e a checagem do diff foram concluídas; a conexão real e a operação no Android precisam ser confirmadas no próprio Termux.
- A licença MIT original foi preservada em `LICENSE`.
- A versão 7 traz mudanças de API em relação à 6; consulte o `README.md` e o [guia de migração](https://whiskey.so/migrate-latest).
- O remoto `origin` continua apontando para o repositório público original. A branch local `minha-versao` acompanha a branch `main` publicada em [AlexandroLeone/Baileys-Termux](https://github.com/AlexandroLeone/Baileys-Termux).
- O projeto usa um protocolo não oficial do WhatsApp Web. A conexão real depende do serviço externo e de uma conta autorizada.
