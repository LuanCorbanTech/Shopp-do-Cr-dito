import { hasExceededMaxAttempts, nextAttemptDate, DEFAULT_BACKOFF_SCHEDULE_SECONDS, DEFAULT_MAX_TENTATIVAS } from "./retry";

// Decisão de retry para uma falha na validação de WhatsApp (seja falha ao iniciar
// a consulta — POST /check deu erro — seja resultado "error" vindo depois, por
// webhook ou por consulta manual). As duas origens de falha devem se comportar
// exatamente igual do ponto de vista da máquina de estados da oferta, então essa
// lógica fica aqui, compartilhada entre apps/workers (worker2-whatsapp.ts) e
// apps/api (whatsapp-validation-handler.ts), em vez de duplicada nos dois.

export interface WhatsappCheckFailureOutcome {
  tentativa: number;
  cancelar: boolean;
  proximaTentativaEm: Date | null;
}

export function decideWhatsappCheckFailureOutcome(params: {
  tentativaAtual: number;
  maxTentativas?: number;
  backoffSchedule?: number[];
  now?: Date;
}): WhatsappCheckFailureOutcome {
  const maxTentativas = params.maxTentativas ?? DEFAULT_MAX_TENTATIVAS;
  const backoffSchedule = params.backoffSchedule ?? DEFAULT_BACKOFF_SCHEDULE_SECONDS;
  const now = params.now ?? new Date();

  const tentativa = params.tentativaAtual + 1;
  const cancelar = hasExceededMaxAttempts(tentativa, maxTentativas);
  return {
    tentativa,
    cancelar,
    proximaTentativaEm: cancelar ? null : nextAttemptDate(tentativa, now, backoffSchedule),
  };
}
