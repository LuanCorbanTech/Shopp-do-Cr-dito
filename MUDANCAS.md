# Nova CRON: Disparo individual (push, 1 lead por ciclo)

## O que foi pedido

Uma nova CRON, ativável/desativável pelo painel, com endpoint cadastrável e
um temporizador configurável. A cada execução, manda **1 lead só** (o mais
antigo aguardando consulta do disparo) por vez — não todos de uma vez.

## Decisões confirmadas com você antes de implementar

1. **1 lead por execução** — nunca manda um lote, sempre 1 por vez.
2. **Depois de enviado, o status muda pra `DISPARO_CONSULTADO`** — mesmo
   comportamento que já existe hoje no endpoint `GET
   /api/v1/leads/aguardando-disparo` (usado por sistemas externos que
   preferem *puxar* em vez de receber via *push*).
3. **Corpo da requisição**: os mesmos campos que já existem hoje no GET
   (id, externalId, nome, cpf, dataNascimento, telefoneWhatsapp,
   possuiWhatsapp, bancoAutorizado, produto, valor, parcelas) — só que 1
   objeto por vez, não um array.

## Como funciona

- **Worker novo** (`worker8-disparo-individual.ts`): reaproveita a MESMA
  claim atômica que o endpoint GET já usa (`claimOffersAguardandoDisparo`,
  com `limit=1`) — nenhuma lógica nova de "escolher qual lead", só decide
  quando rodar e pra onde mandar.
- **Painel Integrações**: nova seção "Disparo individual", mesmo padrão
  visual do "Relatório periódico" (ativar/desativar, URL do endpoint,
  frequência em segundos).
- Config lida do banco a cada ciclo — trocar endpoint/frequência/ativar
  no painel vale a partir do próximo ciclo, sem reiniciar nada.

## Ponto de atenção importante (mesmo risco que o GET já tinha)

Assim que o lead é escolhido (antes mesmo da requisição sair), ele já vira
`DISPARO_CONSULTADO`. Se o endpoint estiver fora do ar ou a requisição
falhar por qualquer motivo, o lead **não volta pra fila sozinho** — ele já
foi "consumido". Isso não é um bug novo: é exatamente o mesmo
comportamento que o endpoint GET já tinha desde que foi criado (a claim é
atômica e acontece antes de qualquer tentativa de entrega). Deixei
documentado no código pra quem for mexer depois não achar que é regressão.

## Validação

- **9 testes automatizados** cobrindo: desativado não chama nada, sem
  endpoint não chama nada, sem lead esperando não chama a rede, sempre
  pede `limit=1` (mesmo com mais gente na fila), corpo da requisição
  correto, erro do endpoint não quebra o worker, exceção de rede não
  quebra o worker.
- **49 testes existentes** continuam passando (rodei a suíte inteira,
  nada quebrou).
- Testei a lógica de salvar configuração (ativar/desativar, campo em
  branco mantém valor atual, valor inválido mantém o anterior) com dados
  reais em Node.
- **Build completo do admin-panel** (`next build`), com checagem de tipos,
  100% limpo.
- Testei visualmente com um servidor real rodando (`next start` + um mock
  da API): a seção nova aparece corretamente, no mesmo padrão visual do
  Relatório periódico.

## Arquivos alterados/novos

- `apps/workers/src/workers/worker8-disparo-individual.ts` (novo)
- `apps/workers/src/workers/worker8-disparo-individual.test.ts` (novo)
- `apps/workers/src/index.ts`
- `apps/api/src/admin/routes.ts`
- `apps/admin-panel/src/app/integracoes/page.tsx`
- `apps/admin-panel/src/app/integracoes/actions.ts`
- `packages/database/src/repositories/admin-repository.ts`

Nenhuma migração de banco — usa a mesma tabela `integration_configs` já
existente (chave nova: `DISPARO_INDIVIDUAL_WEBHOOK`).
