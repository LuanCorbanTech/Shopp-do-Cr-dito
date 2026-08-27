# Disparo individual — múltiplos endpoints em paralelo

## O que foi pedido

Aumentar o throughput do Disparo individual (hoje limitado a ~60/min com 1
endpoint só) permitindo cadastrar **vários endpoints**, cada um recebendo 1
lead por ciclo, todos enviados **ao mesmo tempo** — multiplicando o total
pelo número de endpoints ativos.

## O que mudou

- **Worker (`worker8-disparo-individual.ts`)**: em vez de pegar 1 lead e
  mandar pra 1 endpoint, agora pega **até 1 lead pra cada endpoint ativo**
  (numa única chamada atômica) e manda todos com `Promise.allSettled` — em
  paralelo de verdade, e a falha de 1 endpoint nunca afeta os outros.
- **Painel Integrações**: o campo único "URL do endpoint" virou uma lista
  editável — adicionar quantos endpoints quiser, ativar/desativar cada um
  individualmente (sem precisar remover), e remover quando não precisar
  mais.
- **Migração automática**: sua configuração atual (1 endpoint só, formato
  antigo) é lida e convertida sozinha pro formato novo na primeira vez que
  a tela carregar — não precisa fazer nada manual, e assim que salvar pela
  tela nova já fica gravado no formato novo.

## Sobre duplicidade (o ponto que você levantou)

Confirmado com um teste real, usando 2 conexões simultâneas ao banco de
dados (não sequenciais) disputando os mesmos registros: **zero
sobreposição** possível. Isso não depende de nenhuma lógica no worker — é
uma trava no próprio banco (`FOR UPDATE SKIP LOCKED`), a mesma técnica já
usada em todo o resto do sistema. Um lead nunca pode ser capturado duas
vezes, mesmo com múltiplos endpoints disputando ao mesmo tempo.

## Validação

- **65 testes automatizados** (57 existentes + 8 novos cobrindo múltiplos
  endpoints: paralelismo de verdade — provado com atrasos diferentes por
  endpoint —, endpoint desativado não recebe nada, falha isolada não
  derruba os outros, menos leads que endpoints não quebra), todos passando.
- Build completo do admin-panel (`next build`) com checagem de tipos,
  limpo.
- Testado visualmente com Playwright: migração automática exibida
  corretamente, adicionar/remover/ativar/desativar endpoints funcionando,
  payload de salvamento conferido.
- `tsc --noEmit` sem erros nos workers.

## Arquivos alterados/novos

- `apps/workers/src/workers/worker8-disparo-individual.ts`
- `apps/workers/src/workers/worker8-disparo-individual.test.ts`
- `apps/workers/src/index.ts`
- `apps/api/src/admin/routes.ts`
- `apps/admin-panel/src/app/integracoes/page.tsx`
- `apps/admin-panel/src/app/integracoes/actions.ts`
- `apps/admin-panel/src/app/integracoes/DisparoIndividualEndpointsEditor.tsx` (novo)
- `packages/database/src/repositories/admin-repository.ts`

Nenhuma migração de banco — mesma tabela `integration_configs`, só mudou o
formato do JSON guardado (com migração automática do formato antigo).
