import type { OfferSnapshot, RoutingRuleSnapshot } from "./ports/pipeline-ports";

// Motor de roteamento (itens 13-17 do escopo original): condicoes é um objeto plano
// de igualdades (AND). A regra mais específica (menor "prioridade") que casa com todos
// os seus próprios campos declarados vence. Regras sem nenhuma condição são um catch-all
// (equivalente ao "Banco = C6 -> Endpoint C6 padrão, prioridade 10" do exemplo do escopo).

// Mapa de chaves aceitas em `condicoes` -> como lê-las da oferta.
const OFFER_FIELD_BY_CONDITION_KEY: Record<string, (offer: OfferSnapshot) => unknown> = {
  bancoAutorizado: (o) => o.bancoAutorizado,
  banco_autorizado: (o) => o.bancoAutorizado,
  webhookId: (o) => o.webhookId,
  webhook_id: (o) => o.webhookId,
  produto: (o) => o.produto,
};

export function ruleMatchesOffer(rule: RoutingRuleSnapshot, offer: OfferSnapshot): boolean {
  const condicoes = rule.condicoes ?? {};
  const keys = Object.keys(condicoes);
  if (keys.length === 0) {
    return true; // regra catch-all
  }
  return keys.every((key) => {
    const getField = OFFER_FIELD_BY_CONDITION_KEY[key];
    if (!getField) {
      // Condição desconhecida: por segurança, não casa (evita rotear com base em
      // uma chave que o motor não sabe interpretar).
      return false;
    }
    return getField(offer) === condicoes[key];
  });
}

/** Regras já devem vir ordenadas por prioridade ascendente (mais específica primeiro). */
export function findMatchingRoutingRule(
  offer: OfferSnapshot,
  rulesSortedByPriority: RoutingRuleSnapshot[]
): RoutingRuleSnapshot | null {
  for (const rule of rulesSortedByPriority) {
    if (ruleMatchesOffer(rule, offer)) {
      return rule;
    }
  }
  return null;
}
