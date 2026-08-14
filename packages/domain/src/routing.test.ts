import { describe, expect, it } from "vitest";
import { findMatchingRoutingRule, ruleMatchesOffer } from "./routing";
import type { OfferSnapshot, RoutingRuleSnapshot } from "./ports/pipeline-ports";

function offer(overrides: Partial<OfferSnapshot> = {}): OfferSnapshot {
  return {
    id: "offer-1",
    webhookId: "webhook-a",
    externalId: null,
    cpf: null,
    telefoneOriginal: "62999999999",
    telefoneAtualizado: null,
    telefoneValidado: null,
    bancoAutorizado: "C6",
    produto: null,
    valor: null,
    parcelas: null,
    status: "AGUARDANDO_ROTEAMENTO",
    routingRuleId: null,
    endpointId: null,
    tentativasTelefone: 0,
    tentativasWhatsapp: 0,
    tentativasEnvio: 0,
    ...overrides,
  };
}

function rule(overrides: Partial<RoutingRuleSnapshot> = {}): RoutingRuleSnapshot {
  return {
    id: "rule-1",
    condicoes: {},
    endpointId: "endpoint-1",
    prioridade: 10,
    ...overrides,
  };
}

describe("ruleMatchesOffer", () => {
  it("regra sem condições é catch-all", () => {
    expect(ruleMatchesOffer(rule({ condicoes: {} }), offer())).toBe(true);
  });

  it("casa quando todas as condições coincidem", () => {
    const r = rule({ condicoes: { bancoAutorizado: "C6", webhookId: "webhook-a" } });
    expect(ruleMatchesOffer(r, offer({ bancoAutorizado: "C6", webhookId: "webhook-a" }))).toBe(true);
  });

  it("não casa quando uma condição diverge", () => {
    const r = rule({ condicoes: { bancoAutorizado: "C6", webhookId: "webhook-b" } });
    expect(ruleMatchesOffer(r, offer({ bancoAutorizado: "C6", webhookId: "webhook-a" }))).toBe(false);
  });

  it("não casa com chave de condição desconhecida", () => {
    const r = rule({ condicoes: { campo_inexistente: "x" } });
    expect(ruleMatchesOffer(r, offer())).toBe(false);
  });
});

describe("findMatchingRoutingRule", () => {
  it("prioriza a regra mais específica (menor número) sobre o catch-all", () => {
    const specific = rule({
      id: "specific",
      condicoes: { bancoAutorizado: "C6", webhookId: "webhook-a" },
      endpointId: "endpoint-c6-a",
      prioridade: 1,
    });
    const catchAll = rule({
      id: "catch-all",
      condicoes: { bancoAutorizado: "C6" },
      endpointId: "endpoint-c6",
      prioridade: 10,
    });

    const match = findMatchingRoutingRule(offer({ bancoAutorizado: "C6", webhookId: "webhook-a" }), [
      specific,
      catchAll,
    ]);

    expect(match?.id).toBe("specific");
  });

  it("cai para o catch-all quando a regra específica não casa", () => {
    const specific = rule({
      id: "specific",
      condicoes: { bancoAutorizado: "C6", webhookId: "webhook-b" },
      prioridade: 1,
    });
    const catchAll = rule({ id: "catch-all", condicoes: { bancoAutorizado: "C6" }, prioridade: 10 });

    const match = findMatchingRoutingRule(offer({ bancoAutorizado: "C6", webhookId: "webhook-a" }), [
      specific,
      catchAll,
    ]);

    expect(match?.id).toBe("catch-all");
  });

  it("retorna null quando nenhuma regra casa (SEM_ROTA_CONFIGURADA)", () => {
    const r = rule({ condicoes: { bancoAutorizado: "ITAU" } });
    const match = findMatchingRoutingRule(offer({ bancoAutorizado: "C6" }), [r]);
    expect(match).toBeNull();
  });
});
