import { logger } from "@plataforma-ofertas/shared";
import { findMatchingRoutingRule, type RoutingPort } from "@plataforma-ofertas/domain";

// Worker 3 — Roteamento (itens 13-17 do escopo original).
// Reprocessa também ofertas SEM_ROTA_CONFIGURADA a cada ciclo — assim, quando o
// administrador cadastra uma regra compatível, a oferta volta ao fluxo automaticamente
// sem intervenção manual (item 17).

export interface RunRoutingWorkerOnceParams {
  routingPort: RoutingPort;
  batchSize?: number;
}

export async function runRoutingWorkerOnce(params: RunRoutingWorkerOnceParams): Promise<number> {
  const { routingPort, batchSize = 50 } = params;

  const [offers, rules] = await Promise.all([
    routingPort.claimOffersForRouting(batchSize),
    routingPort.listActiveRoutingRulesSortedByPriority(),
  ]);

  for (const offer of offers) {
    const rule = findMatchingRoutingRule(offer, rules);
    if (!rule) {
      await routingPort.markNoRoute(offer.id);
      continue;
    }
    const endpointActive = await routingPort.isEndpointActive(rule.endpointId);
    if (!endpointActive) {
      // Regra existe, mas aponta para um endpoint desativado — trata como sem rota
      // válida até o endpoint ser reativado ou a regra ajustada.
      await routingPort.markNoRoute(offer.id);
      logger.warn(
        { offerId: offer.id, routingRuleId: rule.id, endpointId: rule.endpointId },
        "Regra encontrada, mas o endpoint de destino está desativado"
      );
      continue;
    }
    await routingPort.assignRoute(offer.id, { routingRuleId: rule.id, endpointId: rule.endpointId });
  }

  return offers.length;
}
