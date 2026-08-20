# Relatório periódico: filtro de janela de horário (início/fim do envio)

Este zip é **incremental** — pressupõe que os zips anteriores (redesign do
Dashboard, colunas de horário + fuso, integração de Relatório periódico, e a
correção de fuso no "Horário com maior taxa de resposta") já foram aplicados.
Contém só os arquivos alterados desta rodada.

## O que foi pedido

No painel → Integrações → Relatório periódico, adicionar mais um filtro: hora
de início e hora de fim do envio, para o relatório não ser enviado de
madrugada (ou em qualquer horário fora da janela escolhida).

## Como funciona

Duas novas caixas de horário na seção "Relatório periódico" do painel:

- **Não enviar antes de** (ex.: `08:00`)
- **Não enviar depois de** (ex.: `20:00`)

Os dois em **horário de Brasília** — independente do fuso do servidor, mesmo
princípio já usado em toda a correção de fuso deste projeto.

- Se os dois campos estiverem preenchidos, o worker só envia o relatório
  quando o horário atual (em Brasília) estiver dentro da janela. Fora da
  janela, o ciclo é simplesmente pulado (tenta de novo no próximo ciclo,
  seguindo a frequência configurada — nada se perde, só espera a janela abrir
  de novo).
- Se deixar os dois em branco e salvar, não há restrição — envia a qualquer
  hora (era o comportamento antes desse campo existir, continua funcionando
  assim se você não quiser usar o filtro).
- Suporta também uma janela que cruza a meia-noite (ex.: `22:00` até `06:00`,
  se um dia você quiser o oposto — enviar só à noite/madrugada).
- Campo deixado em branco no formulário mantém o valor já salvo (mesma
  convenção dos outros campos desta tela) — só limpa a restrição se você
  apagar os DOIS campos e salvar.

## Onde fica guardado

Mesma chave já usada pela integração (`RELATORIO_PERIODICO_WEBHOOK`, tabela
`integration_configs`, nenhuma migração nova) — só ganhou 2 campos a mais
dentro do JSON: `horaInicio` e `horaFim` (formato `"HH:MM"`).

## Arquivos alterados (9)

| Caminho | O que mudou |
|---|---|
| `packages/domain/src/fuso-horario.ts` | Função nova `estaDentroDaJanelaDeEnvio(agora, horaInicio, horaFim)` — compara o horário atual em Brasília com a janela configurada, incluindo o caso de janela cruzando a meia-noite. |
| `packages/domain/src/fuso-horario.test.ts` | 6 testes novos pra essa função (sem janela, dentro, de madrugada fora, limites exatos inclusivos, janela cruzando meia-noite, config inválida). |
| `packages/database/src/repositories/admin-repository.ts` | `getRelatorioPeriodicoConfig`/`salvarRelatorioPeriodicoConfig` passam a ler/gravar `horaInicio`/`horaFim` (com validação de formato "HH:MM" — valor inválido mantém o que já estava salvo, pra nunca travar o envio por engano). |
| `apps/api/src/admin/routes.ts` | Rota `POST /admin/integrations/relatorio-periodico` passa a aceitar `horaInicio`/`horaFim` no corpo. |
| `apps/workers/src/index.ts` | `resolverConfigRelatorioPeriodico` agora também lê `horaInicio`/`horaFim` do banco e repassa pro worker a cada ciclo. |
| `apps/workers/src/workers/worker7-relatorio-periodico.ts` | Novo guard: antes de montar/enviar o relatório, checa `estaDentroDaJanelaDeEnvio` — fora da janela, o ciclo é ignorado (retorna 0, sem chamar o endpoint). |
| `apps/workers/src/workers/worker7-relatorio-periodico.test.ts` | 3 testes novos (fora da janela não envia, dentro da janela envia, sem janela configurada envia a qualquer hora). |
| `apps/admin-panel/src/app/integracoes/page.tsx` | 2 campos novos (`<input type="time">`) na seção "Relatório periódico": "Não enviar antes de" e "Não enviar depois de", com valores padrão sugeridos de 08:00/20:00. |
| `apps/admin-panel/src/app/integracoes/actions.ts` | `salvarRelatorioPeriodico` passa a ler e enviar `horaInicio`/`horaFim` do formulário. |

## Validação

- `packages/domain`: `npx vitest run` — **42 testes passando** (6 arquivos,
  incluindo os 6 novos de `estaDentroDaJanelaDeEnvio`). Roda 100% sem
  restrição, esse pacote não depende de Prisma.
- `apps/workers`: `npx vitest run src/workers/worker7-relatorio-periodico.test.ts`
  — **10 testes passando** (os 7 de antes + os 3 novos da janela de horário).
- `apps/admin-panel`: `npx tsc --noEmit` (zero erros) e `npx next build`
  (sucesso, as mesmas 24 rotas de antes).
- `packages/database`, `apps/api`, `apps/workers/src/index.ts`: mesma
  limitação de sempre neste ambiente de geração (`prisma generate` bloqueado)
  — conferi que os erros de `tsc` nos trechos alterados são exatamente a
  mesma categoria já presente em código antigo intocado, nenhum erro novo.
- **Nenhuma migração de banco necessária.**

## Exemplo do body que o sistema vai enviar (pro seu endpoint)

Requisição:

```
POST <sua URL cadastrada no painel>
Content-Type: application/json
```

(nenhum outro header é enviado — sem Authorization, sem User-Agent
customizado, só esse.)

Corpo (exemplo — números fictícios, sempre referentes a HOJE em Brasília no
momento do envio):

```json
{
  "Total de ofertas recebidas": 184,
  "Aguardando processamento": 12,
  "Com Lemit validado": 151,
  "Com Whatsapp validado": 97,
  "Aguardando consulta do disparo": 6,
  "Com disparo consultado": 88,
  "Disparo enviado": 76,
  "Disparo respondido": 34,
  "Taxa de resposta": 0.4473684210526316
}
```

Notas pro seu sistema do lado de lá:

- Os 8 primeiros campos são números inteiros (contagens).
- `"Taxa de resposta"` é um número decimal entre `0` e `1` (não é string, não
  vem formatado como "44,7%") — é literalmente `Disparo respondido / Disparo
  enviado`. Se ainda não houve nenhum disparo enviado no dia, vem `0` (nunca
  erro/NaN/null).
- As chaves são exatamente esse texto, com acento e espaço mesmo (ex.:
  `"Com Lemit validado"`), porque foi assim que você pediu.
- O envio só acontece dentro da janela de horário configurada (se você
  configurou uma) e na frequência escolhida — fora disso, nenhuma requisição é
  feita.
