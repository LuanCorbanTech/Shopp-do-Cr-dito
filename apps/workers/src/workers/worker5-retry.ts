import { logger } from "@plataforma-ofertas/shared";
import type { RetryPort } from "@plataforma-ofertas/domain";

// Worker 5 — Retry (item 28 do escopo original). Devolve ofertas ERRO_* elegíveis
// (proxima_tentativa_em já passou) ao estado que faz o worker correspondente
// reprocessá-las. Ofertas que já esgotaram tentativas foram marcadas CANCELADO
// diretamente por quem falhou (Worker 1/2/4) e não aparecem mais aqui.

const TARGET_STATUS_BY_ERROR_STATUS: Record<string, string> = {
  ERRO_TELEFONE: "RECEBIDO",
  ERRO_VALIDACAO_WHATSAPP: "TELEFONE_ATUALIZADO",
  ERRO_ENVIO: "AGUARDANDO_ENVIO",
};

export interface RunRetryWorkerOnceParams {
  retryPort: RetryPort;
  batchSize?: number;
}

export async function runRetryWorkerOnce(params: RunRetryWorkerOnceParams): Promise<number> {
  const { retryPort, batchSize = 50 } = params;

  const offers = await retryPort.findRetryableOffers(batchSize);
  for (const offer of offers) {
    const targetStatus = TARGET_STATUS_BY_ERROR_STATUS[offer.status];
    if (!targetStatus) {
      logger.warn({ offerId: offer.id, status: offer.status }, "Status de erro sem mapeamento de retry conhecido");
      continue;
    }
    await retryPort.revertForRetry(offer.id, targetStatus);
    logger.info({ offerId: offer.id, de: offer.status, para: targetStatus }, "Oferta devolvida para retry");
  }

  return offers.length;
}
