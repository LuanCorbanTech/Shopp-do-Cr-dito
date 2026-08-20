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

/** Converte "HH:MM" em minutos desde a meia-noite; null se o formato for inválido. */
function minutosDesdeMeiaNoite(horaMinuto: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(horaMinuto.trim());
  if (!match) return null;
  const hora = Number(match[1]);
  const minuto = Number(match[2]);
  if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) return null;
  return hora * 60 + minuto;
}

// Janela de horário de envio do relatório periódico (worker7) — o usuário
// configura "não enviar de madrugada", por exemplo horaInicio="08:00" e
// horaFim="20:00", pra restringir os horários em que o POST é disparado. Sem
// janela configurada (qualquer um dos dois em branco/null), não há restrição —
// mantém o comportamento de sempre enviar, igual antes desse campo existir.
// Suporta também janela que cruza a meia-noite (ex.: 22:00 às 06:00).
export function estaDentroDaJanelaDeEnvio(agora: Date, horaInicio?: string | null, horaFim?: string | null): boolean {
  if (!horaInicio || !horaFim) return true;

  const inicioMin = minutosDesdeMeiaNoite(horaInicio);
  const fimMin = minutosDesdeMeiaNoite(horaFim);
  // Config inválida (formato inesperado) — não bloqueia o envio por causa disso.
  if (inicioMin === null || fimMin === null) return true;

  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_BRASILIA,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);
  const hora = Number(partes.find((p) => p.type === "hour")?.value ?? "0");
  const minuto = Number(partes.find((p) => p.type === "minute")?.value ?? "0");
  const agoraMin = hora * 60 + minuto;

  if (inicioMin <= fimMin) {
    return agoraMin >= inicioMin && agoraMin <= fimMin;
  }
  // Janela cruza a meia-noite (ex.: 22:00 às 06:00): dentro se está depois do
  // início OU antes do fim, nunca as duas condições ao mesmo tempo.
  return agoraMin >= inicioMin || agoraMin <= fimMin;
}
