export type Periodo = "hoje" | "7dias" | "30dias" | "mes" | "personalizado";

export const TODOS_STATUS = [
  "RECEBIDO",
  "PROCESSANDO_TELEFONE",
  "TELEFONE_ATUALIZADO",
  "VALIDANDO_WHATSAPP",
  "WHATSAPP_VALIDADO",
  "AGUARDANDO_DISPARO",
  "DISPARO_CONSULTADO",
  "DISPARO_ENVIADO",
  "DISPARO_RESPONDIDO",
  "SEM_WHATSAPP",
  "CPF_INVALIDO",
  "ERRO_TELEFONE",
  "ERRO_VALIDACAO_WHATSAPP",
  "CANCELADO",
  "EXPIRADO",
];

export function calcularIntervalo(periodo: Periodo, customFrom: string, customTo: string): { from?: string; to?: string } {
  const agora = new Date();
  if (periodo === "hoje") {
    const inicio = new Date(agora);
    inicio.setHours(0, 0, 0, 0);
    return { from: inicio.toISOString(), to: agora.toISOString() };
  }
  if (periodo === "7dias") {
    const inicio = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { from: inicio.toISOString(), to: agora.toISOString() };
  }
  if (periodo === "30dias") {
    const inicio = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from: inicio.toISOString(), to: agora.toISOString() };
  }
  if (periodo === "mes") {
    const inicio = new Date(agora.getFullYear(), agora.getMonth(), 1);
    return { from: inicio.toISOString(), to: agora.toISOString() };
  }
  // personalizado
  return {
    from: customFrom ? new Date(customFrom + "T00:00:00").toISOString() : undefined,
    to: customTo ? new Date(customTo + "T23:59:59").toISOString() : undefined,
  };
}
