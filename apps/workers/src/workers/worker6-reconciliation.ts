import { logger } from "@plataforma-ofertas/shared";
import type { ReconciliationPort } from "@plataforma-ofertas/domain";

// Worker 6 — Reconciliação. Garante o requisito do item 4 do escopo original:
// "a arquitetura deverá impedir que uma oferta fique presa indefinidamente em um
// estado". Ofertas em estado transitório (worker caiu/crashou entre reservar e
// concluir) há mais tempo que o SLA voltam para um estado reprocessável.

const RELEASE_TARGET_BY_STATUS: Record<string, string> = {
  PROCESSANDO_TELEFONE: "RECEBIDO",
  VALIDANDO_WHATSAPP: "TELEFONE_ATUALIZADO",
  EM_PROCESSAMENTO_ENVIO: "AGUARDANDO_ENVIO",
  // Nestes dois, o status já é o correto para reprocessar — só falta liberar o lock.
  AGUARDANDO_ROTEAMENTO: "AGUARDANDO_ROTEAMENTO",
  SEM_ROTA_CONFIGURADA: "SEM_ROTA_CONFIGURADA",
};

export interface RunReconciliationWorkerOnceParams {
  reconciliationPort: ReconciliationPort;
  slaMs?: number;
  batchSize?: number;
}

export async function runReconciliationWorkerOnce(params: RunReconciliationWorkerOnceParams): Promise<number> {
  const { reconciliationPort, slaMs = 10 * 60 * 1000, batchSize = 100 } = params;

  const stuckOffers = await reconciliationPort.findStuckOffers(slaMs, batchSize);
  for (const offer of stuckOffers) {
    const targetStatus = RELEASE_TARGET_BY_STATUS[offer.status];
    if (!targetStatus) {
      logger.warn({ offerId: offer.id, status: offer.status }, "Status travado sem alvo de liberação conhecido");
      continue;
    }
    await reconciliationPort.releaseStuckOffer(offer.id, targetStatus);
    logger.warn(
      { offerId: offer.id, status: offer.status, reservedAt: offer.reservedAt },
      "Oferta travada liberada pela reconciliação"
    );
  }

  return stuckOffers.length;
}
