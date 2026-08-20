// Horário de Brasília (America/Sao_Paulo) é UTC-3 fixo, sem horário de verão desde
// 2019 — então "início do dia em Brasília" pode ser calculado sem depender de
// nenhuma biblioteca de timezone: basta descobrir que dia (ano/mês/dia) é "agora"
// em Brasília (via Intl.DateTimeFormat, que sabe a regra oficial do fuso) e montar
// a meia-noite de Brasília daquele dia em UTC (meia-noite BRT = 03:00 UTC).
//
// Isso é usado pelo worker7-relatorio-periodico (apps/workers) para o filtro
// "sempre as informações do dia" ser o dia em Brasília, e não o dia do servidor
// (que normalmente roda em UTC) — mesmo princípio de correção de fuso horário já
// aplicado no painel (apps/admin-panel/src/lib/data-hora.ts), agora do lado do
// backend/worker.

const FUSO_BRASILIA = "America/Sao_Paulo";

/** Retorna a data/hora UTC correspondente à meia-noite de "hoje" em Brasília. */
export function inicioDoDiaEmBrasilia(agora: Date = new Date()): Date {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_BRASILIA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);

  const ano = partes.find((p) => p.type === "year")?.value;
  const mes = partes.find((p) => p.type === "month")?.value;
  const dia = partes.find((p) => p.type === "day")?.value;
  if (!ano || !mes || !dia) {
    throw new Error("Não foi possível determinar a data atual em Brasília");
  }

  // Meia-noite BRT (UTC-3) = 03:00 UTC do mesmo dia.
  return new Date(`${ano}-${mes}-${dia}T03:00:00.000Z`);
}
