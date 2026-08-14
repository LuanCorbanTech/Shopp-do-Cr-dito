# Plataforma de Gestão, Validação, Roteamento e Disparo de Ofertas

Motor de processamento e roteamento de ofertas/leads via WhatsApp: recebe via webhook,
valida telefone (API Limit, opcional/configurável), valida WhatsApp, roteia por banco
autorizado e outras regras, controla capacidade por endpoint e dispara via Hyperflow.

O documento completo de arquitetura (fluxos, máquina de estados, modelo de dados,
estratégias de fila/concorrência/rate limiting/retry, painel, segurança/LGPD e plano de
fases) está em `arquitetura-plataforma-ofertas.md` na pasta do projeto.

## Status atual

**Fases 0 a 8 implementadas** (base, webhook de ingestão, os 6 workers do pipeline,
API administrativa e painel Next.js, segurança/observabilidade básicas). A Fase 9
(carga/produção) tem o script pronto (`loadtest/`) mas não foi executada — ver
"Limitações conhecidas" abaixo.

### O pipeline (Fases 1-6)

`POST /webhooks/ofertas/:identificador` grava a oferta como `RECEBIDO` (idempotente,
assinado por HMAC, nunca chama nada de forma síncrona — item 46 do escopo) e a partir
daí os 6 workers levam a oferta até `ENVIADO`:

| Worker | Arquivo | Faz |
|---|---|---|
| 1 — Limit | `apps/workers/src/workers/worker1-limit.ts` | Se `LIMIT_CONSULTA` estiver ativo no painel, consulta a API Limit; senão usa o telefone original sem nenhuma chamada externa. |
| 2 — WhatsApp | `worker2-whatsapp.ts` | Valida o telefone resolvido pelo Worker 1; `SEM_WHATSAPP` é estado terminal. |
| 3 — Roteamento | `worker3-routing.ts` | Aplica `routing_rules` por prioridade; sem match vira `SEM_ROTA_CONFIGURADA` e é reprocessada automaticamente quando uma regra compatível é cadastrada. |
| 4 — Disparo | `worker4-dispatch.ts` | Reserva capacidade no Redis (por minuto/hora/dia), reclama ofertas do endpoint no Postgres e dispara via `HyperflowService`. |
| 5 — Retry | `worker5-retry.ts` | Devolve ofertas `ERRO_*` para reprocessamento quando a janela de backoff passou; nunca é infinito. |
| 6 — Reconciliação | `worker6-reconciliation.ts` | Libera ofertas travadas (worker morto no meio do processamento) de volta a um estado reprocessável. |

A reserva de ofertas usa SQL bruto (`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
LOCKED) RETURNING ...`, em `packages/database/src/repositories/prisma-pipeline-
repository.ts`) — **validado contra um Postgres real** durante o desenvolvimento (duas
transações concorrentes disputando as mesmas linhas, confirmando que nenhuma é
processada duas vezes). O rate limiting por endpoint usa um contador atômico no Redis
(`packages/queue/src/capacity.ts`), também validado sob concorrência real (20 chamadas
paralelas com limite 10 → exatamente 10 concedidas).

**Desvio deliberado vs. o doc de arquitetura:** o Worker 4 usa polling direto na tabela
`offers` + contador Redis, em vez de BullMQ como o doc original sugeria. Motivo: BullMQ
exigiria que o Worker 3 também enfileirasse um job ao rotear (dupla escrita — Postgres
diz `AGUARDANDO_ENVIO`, mas o job correspondente no Redis pode se perder), e mantém os
6 workers no mesmo formato simples (polling), mais fácil de operar e de verificar sem
uma fila de jobs adicional. BullMQ continua sendo uma evolução possível sem mudar o
schema, se o volume real justificar.

### API administrativa e painel (Fases 7-8)

- `apps/api/src/admin/routes.ts`: dashboard geral, toggle do Limit, CRUD de endpoints e
  regras de roteamento, listagem/detalhe/timeline de ofertas — tudo sob `/admin/*`,
  protegido por Bearer token (`ADMIN_API_TOKEN`).
- `apps/admin-panel`: painel em Next.js (App Router) consumindo essa API — Dashboard,
  Integrações (toggle do Limit), Endpoints, Regras de roteamento, Ofertas + timeline.
  O token só existe no processo servidor do Next.js (Server Components/Actions),
  nunca chega ao navegador.
- `/metrics` (Prometheus) e mascaramento de CPF/telefone em log (`packages/shared/src/
  logger.ts`, `secrets.ts`) — segurança e observabilidade básicas (seção 9-10 do doc).

**Simplificação deliberada:** a autenticação do painel é um token Bearer estático via
variável de ambiente, não um sistema de usuários/RBAC completo (o escopo original pede
"controle de permissões", mas não define um modelo de usuários — um token único cobre
o mínimo de "só quem tem a credencial acessa" sem inventar um esquema não especificado;
ver comentário em `apps/api/src/admin/auth.ts`).

### Testes

61 testes automatizados, todos passando: **48 unitários** (roteamento, backoff, HMAC,
idempotência, orquestração dos 6 workers contra um fake em memória de todas as portas
do banco — inclui um teste ponta a ponta que simula uma oferta atravessando os 6
workers até `ENVIADO`) e **13 de integração real contra Redis** (rate limiting/
capacidade — não mockado). Rodar:

```bash
npm test                                    # tudo que não depende de infra externa
REDIS_URL=redis://localhost:6379 npm test   # inclui os testes de integração com Redis
```

## Estrutura

```
/apps
  /api            -> Fastify: webhook + API administrativa + /metrics
  /workers        -> os 6 workers do pipeline (polling loops)
  /admin-panel    -> Next.js — painel administrativo
/packages
  /domain         -> tipos, portas (interfaces) e lógica pura (roteamento, backoff)
  /database       -> schema Prisma + implementação das portas via Prisma Client
  /queue          -> conexão Redis + contador de capacidade (rate limiting)
  /integrations   -> Limit, WhatsApp, Hyperflow (um cliente HTTP configurável por serviço)
  /shared         -> logger (mascaramento de PII), resolução de secrets
/loadtest         -> script k6 para a Fase 9 (não executado neste repositório)
```

A lógica de negócio (handlers dos webhooks, dos 6 workers, roteamento) depende só de
interfaces (`packages/domain/src/ports`), nunca do Prisma diretamente — por isso é
testável com fakes em memória, sem precisar de banco para a maior parte dos testes.

## Setup local

Pré-requisitos: Node.js 20+, Docker (ou Postgres 15+/Redis 7+ instalados localmente).

```bash
cp .env.example .env
npm install

docker compose up -d postgres redis
npm run prisma:migrate
npm run seed --workspace=@plataforma-ofertas/database   # cria um webhook de teste

npm run dev:api        # http://localhost:3000  (webhook + /admin/* + /metrics)
npm run dev:workers    # os 6 workers
npm run dev --workspace=@plataforma-ofertas/admin-panel  # http://localhost:3001
```

### Testar o webhook manualmente

```bash
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
```

## Plano de fases

Ver seção 12 do documento de arquitetura.

0. ✅ Base — repo, Docker Compose, schema Prisma, CI.
1. ✅ Ingestão via webhook + idempotência.
2. ✅ API Limit configurável (Worker 1) + fallback de telefone original.
3. ✅ Validação de WhatsApp (Worker 2).
4. ✅ Motor de roteamento (Worker 3) + endpoints.
5. ✅ Fila por endpoint, rate limiting, disparo (Worker 4) + HyperflowService.
6. ✅ Retry (Worker 5) e reconciliação (Worker 6).
7. ✅ Painel administrativo (dashboard, integrações, endpoints, regras, timeline).
8. ✅ Segurança (HMAC, auth admin, mascaramento de PII) e observabilidade (`/metrics`).
9. ⚠️ Testes de carga: script k6 pronto em `loadtest/`, não executado (sem infra real disponível no ambiente de desenvolvimento).
10. (Futuro) Distribuição percentual entre endpoints, outros canais (SMS/e-mail), A/B testing.

## Limitações conhecidas (leia antes de assumir que algo foi testado em produção)

- **`prisma generate`/`migrate` não roda no ambiente onde este código foi escrito**
  (a rede desse ambiente bloqueia o download do engine da Prisma em
  `binaries.prisma.sh`) — isso é uma restrição do ambiente de desenvolvimento, não do
  código. Na sua máquina, com internet normal, funciona normalmente. Por causa disso,
  o único pacote que não pôde ser type-checado localmente foi
  `@plataforma-ofertas/database`; todo o resto (workers, rotas, lógica de domínio)
  foi verificado com `tsc --noEmit` sem erros.
- Para compensar a falta do Prisma Client, o SQL de concorrência (`SELECT ... FOR
  UPDATE SKIP LOCKED` usado em `prisma-pipeline-repository.ts`) foi validado
  manualmente contra um Postgres real instalado no ambiente de desenvolvimento —
  duas transações concorrentes disputando as mesmas linhas, confirmando que
  nenhuma é processada duas vezes — mas essa validação **não ficou como teste
  automatizado no repositório** (o Postgres de teste foi montado à mão, sem passar
  pelas migrations do Prisma, então não é reproduzível via `npm test`). O contador
  de capacidade do Redis, por outro lado, **é** testado automaticamente contra Redis
  real (`packages/queue/src/capacity.test.ts`, `worker4-dispatch.test.ts`,
  `pipeline.e2e.test.ts`) — esses continuam rodando sempre que houver Redis
  disponível (`REDIS_URL`), inclusive no CI.
- **LimitService, WhatsAppValidationService e HyperflowService são clientes HTTP
  genéricos** (`packages/integrations/*`), com um contrato REST razoável assumido na
  ausência da documentação real dessas APIs no escopo original. Ajustar a rota/formato
  de payload/resposta quando a documentação real estiver disponível é uma mudança
  isolada em cada um desses arquivos — o resto do sistema não precisa mudar.
- **Nunca houve um teste end-to-end contra o sistema rodando de ponta a ponta**
  (API + workers + Postgres + Redis + integrações externas reais simultaneamente) —
  o teste "ponta a ponta" mencionado acima (`pipeline.e2e.test.ts`) simula os 6
  workers em sequência sobre um repositório em memória, o que verifica a orquestração
  entre eles, mas não substitui rodar o sistema de verdade.
- O painel administrativo (Next.js) compila e type-checa (`next build` passou), mas
  não foi testado contra a API rodando de verdade (mesma limitação do Prisma acima
  impede rodar a API completa neste ambiente).
- Autenticação do painel é um token único (ver seção acima) — trocar por login
  multiusuário antes de expor a um time maior que uma pessoa.
