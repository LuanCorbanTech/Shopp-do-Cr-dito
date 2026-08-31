# Disparo individual — suporte a múltiplos "modelos" (Hyperflow + Ararahq)

## O que foi pedido

Cada endpoint cadastrado no Disparo individual passa a ter um **modelo**
(Hyperflow ou Ararahq, extensível pra mais no futuro) — o sistema monta a
requisição no formato certo pra cada um.

## O que mudou

- **Cada linha da lista de endpoints** ganhou um seletor "Hyperflow /
  Ararahq". Migração automática: qualquer endpoint já cadastrado (de antes
  desse campo existir) vira "Hyperflow" sozinho — era o único formato que
  existia.
- **Formato Hyperflow** (sem mudança): corpo completo do lead, sem
  autenticação.
- **Formato Ararahq** (novo): corpo simples `{"phone": "+55...", "name":
  "..."}`, com cabeçalhos `Authorization: Bearer <chave>` e
  `Idempotency-Key` (UUID novo a cada envio, nunca repete — confirmado como
  requisito do dev deles).
- **1 chave de API só**, compartilhada por todos os endpoints Ararahq
  (confirmado com você — não é por endpoint), mascarada na tela (mesmo
  padrão da Lemit/CorbanTech), com "deixe em branco pra manter a atual".
- **Telefone com "+" na frente** só pro formato Ararahq — a Hyperflow
  continua exatamente igual a antes (sem "+"), nenhum risco de quebrar o
  que já funciona.
- Endpoints de modelos diferentes podem coexistir no mesmo ciclo — cada um
  recebe o formato certo, sem misturar (testado explicitamente).

## Validação

- **24 testes** no arquivo do worker (16 anteriores + 8 novos específicos
  da Ararahq): formato do corpo, cabeçalhos corretos, Idempotency-Key
  sempre diferente a cada envio, formato de UUID válido, e o teste mais
  importante — Hyperflow e Ararahq no mesmo ciclo, cada um recebendo o
  formato certo sem contaminação.
- **73 testes no total** (suíte inteira), todos passando.
- Migração testada com Node em 3 cenários: formato bem antigo (1 URL),
  formato intermediário (lista sem modelo), formato novo completo.
- Build completo do admin-panel (`next build`), limpo.
- Testado visualmente com Playwright: 2 endpoints (1 Hyperflow, 1 Ararahq)
  lado a lado, aviso de "preencha a chave" aparecendo corretamente, chave
  mascarada exibida certinho.

## Arquivos alterados

- `apps/workers/src/workers/worker8-disparo-individual.ts`
- `apps/workers/src/workers/worker8-disparo-individual.test.ts`
- `apps/workers/src/index.ts`
- `apps/api/src/admin/routes.ts`
- `apps/admin-panel/src/app/integracoes/page.tsx`
- `apps/admin-panel/src/app/integracoes/actions.ts`
- `apps/admin-panel/src/app/integracoes/DisparoIndividualEndpointsEditor.tsx`
- `packages/database/src/repositories/admin-repository.ts`

Nenhuma migração de banco — mesma tabela `integration_configs`, com
migração automática do formato antigo (endpoints sem modelo viram
"hyperflow" sozinhos, sem precisar reconfigurar nada).
