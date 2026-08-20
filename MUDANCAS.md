# Relatório periódico: Taxa_de_resposta agora em porcentagem

Este zip é **incremental** — pressupõe que todos os zips anteriores já foram
aplicados. Contém só os 2 arquivos alterados desta rodada.

## O que foi pedido

O campo `Taxa_de_resposta` estava vindo como fração (0 a 1, ex.: `0.5`) —
pedido pra vir em porcentagem.

## A mudança

`Taxa_de_resposta` agora é `(Disparo_respondido / Disparo_enviado) * 100`,
arredondado em 2 casas decimais — ex.: `50` em vez de `0.5`, ou `44.74` em vez
de `0.4473684210526316`.

Continua sendo um **número** (não string com o símbolo `%` dentro) — pra não
obrigar quem for consumir a fazer `parseFloat` do outro lado. Se quiser que
venha como string tipo `"44.74%"` em vez de número, me avisa que eu troco.

Continua `0` (nunca erro/NaN) quando ainda não houve nenhum disparo enviado no
dia.

## Arquivo alterado (1) + teste atualizado (1)

| Caminho | O que mudou |
|---|---|
| `apps/workers/src/workers/worker7-relatorio-periodico.ts` | `montarRelatorioPeriodicoBody`: `Taxa_de_resposta` multiplicado por 100 e arredondado em 2 casas decimais. |
| `apps/workers/src/workers/worker7-relatorio-periodico.test.ts` | Testes atualizados pro valor em porcentagem, incluindo um caso de arredondamento (34/76 → 44.74). |

## Novo exemplo do body

```json
{
  "Total_de_ofertas_recebidas": 184,
  "Aguardando_processamento": 12,
  "Com_Lemit_validado": 151,
  "Com_Whatsapp_validado": 97,
  "Aguardando_consulta_do_disparo": 6,
  "Com_disparo_consultado": 88,
  "Disparo_enviado": 76,
  "Disparo_respondido": 34,
  "Taxa_de_resposta": 44.74
}
```

## Validação

`npx vitest run src/workers/worker7-relatorio-periodico.test.ts` (dentro de
`apps/workers`) — **11 testes passando** (os 10 de antes + 1 novo de
arredondamento).
