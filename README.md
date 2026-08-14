# Plataforma de Gestão, Validação, Roteamento e Disparo de Ofertas

Motor de processamento e roteamento de ofertas/leads via WhatsApp: recebe via webhook,
valida telefone (API Limit, opcional/configurável), valida WhatsApp, roteia por banco
autorizado e outras regras, controla capacidade por endpoint e dispara via Hyperflow.

O documento completo de arquitetura (fluxos, máquina de estados, modelo de dados,
estratégias de fila/concorrência/rate limiting/retry, painel, segurança/LGPD e plano de
fases) está em `arquitetura-plataforma-ofertas.md` na pasta do projeto.

## Status atual

**Fase 0 concluída** (monorepo, Docker Compose, schema Prisma, CI) **e Fase 1 concluída**
(webhook de ingestão + idempotência + verificação HMAC). Próximo passo: Fase 2 (Worker 1 —
consulta configurável à API Limit).

### Webhook de ingestão (Fase 1)

`POST /webhooks/ofertas/:identificador`

- Responde rápido e só grava no banco (status `RECEBIDO`) — não chama Limit, WhatsApp,
  roteamento ou Hyperflow de forma síncrona (item 46 do doc de arquitetura).
- Exige assinatura HMAC-SHA256 nos headers `X-Ofertas-Timestamp` (unix seconds) e
  `X-Ofertas-Signature` = `HMAC_SHA256(secret, "${timestamp}.${rawBody}")` em hex.
  O timestamp precisa estar dentro de `WEBHOOK_HMAC_DEFAULT_TOLERANCE_SECONDS` (proteção
  contra replay).
- Idempotente: usa `idempotency_key` (se enviado) > `external_id` > hash do payload,
  respeitando a constraint única `(webhook_id, idempotency_key)` — reenvios da mesma
  oferta retornam `200 { status: "ja_recebido" }` em vez de duplicar.
- Corpo mínimo: `{ "telefone": "62999999999", ... }` (demais campos do item 2 do escopo
  são opcionais; o payload inteiro é preservado em `payload_original`).

Lógica de negócio (`apps/api/src/webhooks/handler.ts`) depende só da interface
`OffersPort` (`packages/domain`), não do Prisma diretamente — por isso é testável sem
banco (ver `apps/api/src/webhooks/*.test.ts`, 15 testes cobrindo assinatura, replay,
idempotência e payload inválido).

#### Testar localmente

```bash
# 1. sobe Postgres/Redis, aplica schema e cria um webhook de teste
docker compose up -d postgres redis
npm run prisma:migrate
npm run seed --workspace=@plataforma-ofertas/database   # imprime identificador + secret

# 2. sobe a API
npm run dev:api

# 3. em outro terminal, assina e envia uma oferta de teste
node -e '
const crypto = require("crypto");
const secret = "COLE_O_SECRET_IMPRESSO_PELO_SEED";
const body = JSON.stringify({ telefone: "62999999999", banco_autorizado: "C6" });
const ts = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
console.log(`curl -s -X POST http://localhost:3000/webhooks/ofertas/origem-teste \\
  -H "Content-Type: application/json" \\
  -H "X-Ofertas-Timestamp: ${ts}" \\
  -H "X-Ofertas-Signature: ${sig}" \\
  -d '"'"'${body}'"'"'`);
'
# copie e rode o curl impresso
```

## Estrutura

```
/apps
  /api            -> Fastify: webhooks + API do painel (placeholder na Fase 0)
  /workers        -> 6 workers do pipeline (placeholder na Fase 0)
  /admin-panel    -> Next.js (a partir da Fase 7)
/packages
  /domain         -> tipos e enums compartilhados (status da oferta)
  /database       -> schema Prisma + client compartilhado
  /queue          -> configuração BullMQ/Redis
  /integrations   -> Limit, WhatsApp, Hyperflow (um serviço por integração)
  /shared         -> logger (com mascaramento de PII) e utils
```

## Setup local

Pré-requisitos: Node.js 20+, Docker.

```bash
cp .env.example .env
npm install

# sobe Postgres e Redis
docker compose up -d postgres redis

# aplica o schema inicial no banco
npm run prisma:migrate

npm run dev:api       # sobe a API (placeholder) em http://localhost:3000/health
npm run dev:workers   # sobe os workers (placeholder)
```

## Plano de fases

Ver seção 12 do documento de arquitetura. Resumo:

0. ✅ Base — repo, Docker Compose, schema Prisma, CI.
1. ✅ Ingestão via webhook + idempotência.
2. API Limit configurável (Worker 1) + fallback de telefone original. *(próxima)*
3. Validação de WhatsApp (Worker 2).
4. Motor de roteamento (Worker 3) + endpoints.
5. Fila por endpoint, rate limiting, disparo (Worker 4) + HyperflowService.
6. Retry (Worker 5) e reconciliação (Worker 6).
7. Painel administrativo completo.
8. Segurança, LGPD, observabilidade.
9. Testes de carga e produção.
10. (Futuro) Distribuição percentual entre endpoints, outros canais.
