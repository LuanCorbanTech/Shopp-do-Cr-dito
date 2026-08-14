import { logger, maskPhone } from "@plataforma-ofertas/shared";
import {
  nextAttemptDate,
  hasExceededMaxAttempts,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
  DEFAULT_MAX_TENTATIVAS,
  type WhatsappValidationPort,
  type IntegrationConfigPort,
} from "@plataforma-ofertas/domain";

// Worker 2 — Validação WhatsApp (item 12 do escopo original).
// Usa telefone_atualizado se o Limit rodou; senão cai para telefone_original —
// a decisão "qual telefone usar" já foi resolvida pelo Worker 1 (item 12: "EM AMBOS OS
// CASOS -> validar WhatsApp").

export interface WhatsappValidator {
  validate(telefone: string): Promise<{ possuiWhatsapp: boolean; respostaBruta: unknown }>;
}

export interface RunWhatsappWorkerOnceParams {
  whatsappPort: WhatsappValidationPort;
  configPort: IntegrationConfigPort;
  whatsappService: WhatsappValidator;
  batchSize?: number;
  now?: Date;
}

export async function runWhatsappWorkerOnce(params: RunWhatsappWorkerOnceParams): Promise<number> {
  const { whatsappPort, configPort, whatsappService, batchSize = 20, now = new Date() } = params;

  const config = await configPort.getConfig("WHATSAPP_VALIDACAO");
  const maxTentativas = Number(config?.valor.maxTentativas ?? DEFAULT_MAX_TENTATIVAS);
  const schedule = Array.isArray(config?.valor.backoffSecondsSchedule)
    ? (config!.valor.backoffSecondsSchedule as number[])
    : DEFAULT_BACKOFF_SCHEDULE_SECONDS;

  const offers = await whatsappPort.claimOffersForValidation(batchSize);

  for (const offer of offers) {
    const telefoneUsado = offer.telefoneAtualizado ?? offer.telefoneOriginal;
    const tentativa = offer.tentativasWhatsapp + 1;
    try {
      const result = await whatsappService.validate(telefoneUsado);
      await whatsappPort.markWhatsappValidated(offer.id, {
        possuiWhatsapp: result.possuiWhatsapp,
        respostaBruta: result.respostaBruta,
        telefoneUsado,
      });
    } catch (error) {
      const cancelar = hasExceededMaxAttempts(tentativa, maxTentativas);
      await whatsappPort.markWhatsappFailed(offer.id, {
        erro: error instanceof Error ? error.message : String(error),
        tentativa,
        proximaTentativaEm: cancelar ? null : nextAttemptDate(tentativa, now, schedule),
        cancelar,
      });
      logger.warn(
        { offerId: offer.id, telefone: maskPhone(telefoneUsado), tentativa, cancelar },
        "Falha na validação de WhatsApp"
      );
    }
  }

  return offers.length;
}
