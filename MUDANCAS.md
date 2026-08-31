# Registro visível de cada tentativa de Disparo individual

## O problema

Não tinha como ver, na própria oferta, se o Disparo individual tentou
enviar, pra qual endpoint, e se deu certo — só existia como log de sistema
(console), exigindo caçar no Runtime Logs do servidor.

## O que mudou

- **Tabela nova no banco** (`disparo_individual_tentativas`) — grava toda
  tentativa (sucesso ou falha), com endpoint, modelo (Hyperflow/Ararahq),
  status HTTP, se foi timeout, e a mensagem de erro quando falha.
- **Worker** grava isso automaticamente a cada envio — e se a própria
  gravação falhar (banco fora do ar num instante ruim), isso nunca afeta o
  resultado do envio em si (só vira um aviso no log, testado
  explicitamente).
- **Tela da oferta** (`/ofertas/[id]`) ganhou uma seção nova "Disparo
  individual", mostrando cada tentativa: data/hora, endpoint, modelo,
  "Enviado" (verde) ou "Falhou" (vermelho), status HTTP, e o motivo do erro
  quando aplicável.

## ⚠️ Importante pro deploy

Essa entrega inclui uma **migração de banco** (arquivo `migration.sql`,
cria a tabela nova). Precisa rodar `prisma migrate deploy` (ou o
equivalente que o pipeline de deploy já usa) — sem isso, o worker vai
começar a dar erro ao tentar gravar as tentativas assim que subir o código
novo.

## Validação

- Migration testada aplicando do zero, em sequência com todas as
  anteriores, num Postgres real — sem erro.
- **78 testes** no total (5 novos específicos do registro: sucesso, falha
  com status HTTP, falha por timeout, falha ao gravar não afeta o envio,
  registro por endpoint quando são vários).
- Build completo do admin-panel, limpo.
- Testado visualmente com Playwright: 3 tentativas simuladas (sucesso,
  falha com HTTP 401, falha por timeout) — tudo aparecendo corretamente
  formatado e colorido.

## Arquivos alterados

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20260831170000_disparo_individual_tentativas/migration.sql` (novo)
- `packages/database/src/repositories/prisma-pipeline-repository.ts`
- `packages/database/src/repositories/admin-repository.ts`
- `apps/workers/src/workers/worker8-disparo-individual.ts`
- `apps/workers/src/workers/worker8-disparo-individual.test.ts`
- `apps/api/src/admin/routes.ts`
- `apps/admin-panel/src/app/ofertas/[id]/page.tsx`
