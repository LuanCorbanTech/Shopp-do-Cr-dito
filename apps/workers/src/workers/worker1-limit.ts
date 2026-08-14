import { logger, maskPhone } from "@plataforma-ofertas/shared";
import {
  nextAttemptDate,
  hasExceededMaxAttempts,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
  DEFAULT_MAX_TENTATIVAS,
  type PhoneProcessingPort,
  type IntegrationConfigPort,
} from "@plataforma-ofertas/domain";

// Worker 1 — Processamento inicial (itens 5-11 do escopo original).
// Se "LIMIT_CONSULTA" estiver desativado no painel, usa o telefone original sem
// nenhuma chamada externa (item 8) — a oferta nunca fica presa em RECEBIDO.
// Se estiver ativado, consulta a API Limit; falhas entram em retry com backoff,
// nunca infinito (item 28).

export interface LimitLookup {
  lookupPhone(params: { cpf: string | null; telefoneOriginal: string }): Promise<{
    telefoneAtualizado: string | null;
    respostaBruta: unknown;
  }>;
}

export interface RunLimitWorkerOnceParams {
  phonePort: PhoneProcessingPort;
  configPort: IntegrationConfigPort;
  limitService: LimitLookup;
  batchSize?: number;
  now?: Date;
}

export async function runLimitWorkerOnce(params: RunLimitWorkerOnceParams): Promise<number> {
  const { phonePort, configPort, limitService, batchSize = 20, now = new Date() } = params;

  const config = await configPort.getConfig("LIMIT_CONSULTA");
  const limitEnabled = config?.ativo ?? false;
  const maxTentativas = Number(config?.valor.maxTentativas ?? DEFAULT_MAX_TENTATIVAS);
  const schedule = Array.isArray(config?.valor.backoffSecondsSchedule)
    ? (config!.valor.backoffSecondsSchedule as number[])
    : DEFAULT_BACKOFF_SCHEDULE_SECONDS;

  const offers = await phonePort.claimOffersReceived(batchSize);

  for (const offer of offers) {
    if (!limitEnabled) {
      await phonePort.markPhoneSkippedLimitDisabled(offer.id);
      logger.info(
        { offerId: offer.id, telefone: maskPhone(offer.telefoneOriginal) },
        "Consulta Limit ignorada: integração desativada no painel. Telefone original mantido."
      );
      continue;
    }

    const tentativa = offer.tentativasTelefone + 1;
    try {
      const result = await limitService.lookupPhone({
        cpf: offer.cpf,
        telefoneOriginal: offer.telefoneOriginal,
      });
      await phonePort.markPhoneUpdated(offer.id, {
        telefoneAtualizado: result.telefoneAtualizado ?? offer.telefoneOriginal,
        respostaBruta: result.respostaBruta,
        tentativa,
      });
    } catch (error) {
      const cancelar = hasExceededMaxAttempts(tentativa, maxTentativas);
      await phonePort.markPhoneFailed(offer.id, {
        erro: error instanceof Error ? error.message : String(error),
        tentativa,
        proximaTentativaEm: cancelar ? null : nextAttemptDate(tentativa, now, schedule),
        cancelar,
      });
      logger.warn(
        { offerId: offer.id, telefone: maskPhone(offer.telefoneOriginal), tentativa, cancelar },
        "Falha na consulta à API Limit"
      );
    }
  }

  return offers.length;
}
