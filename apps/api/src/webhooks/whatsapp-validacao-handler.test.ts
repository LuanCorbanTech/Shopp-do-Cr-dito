import { describe, expect, it } from "vitest";
import type { WhatsappValidationPort, IntegrationConfigPort, OfferSnapshot } from "@plataforma-ofertas/domain";
import { handleWhatsappValidacaoWebhook } from "./whatsapp-validacao-handler";

const TOKEN = "segredo-do-webhook-whatsapp";

// Fake mínimo só com o que o handler usa (findOfferByWhatsappRequestId,
// markWhatsappValidated, markWhatsappFailed, getConfig) — não precisa replicar o
// InMemoryPipelineRepository completo dos workers (que cobre os 6 workers).
class FakeWhatsappPort implements Pick<WhatsappValidationPort, "findOfferByWhatsappRequestId" | "markWhatsappValidated" | "markWhatsappFailed">, IntegrationConfigPort {
  readonly offers = new Map<string, OfferSnapshot & { tentativasWhatsapp: number }>();
  config: Record<string, unknown> | null = null;

  addOffer(offer: Partial<OfferSnapshot> & { id: string; whatsappRequestId: string }): void {
    this.offers.set(offer.id, {
      webhookId: "webhook-1",
      externalId: null,
      cpf: null,
      telefoneOriginal: "62999999999",
      telefoneAtualizado: null,
      telefoneValidado: null,
      bancoAutorizado: null,
      produto: null,
      valor: null,
      parcelas: null,
      status: "VALIDANDO_WHATSAPP",
      routingRuleId: null,
      endpointId: null,
      tentativasTelefone: 0,
      tentativasWhatsapp: 0,
      tentativasEnvio: 0,
      whatsappCheckIniciadoEm: new Date(),
      ...offer,
    });
  }

  async getConfig(chave: string) {
    if (!this.config) return null;
    return { chave, ativo: true, valor: this.config };
  }

  async findOfferByWhatsappRequestId(requestId: string): Promise<OfferSnapshot | null> {
    return [...this.offers.values()].find((o) => o.whatsappRequestId === requestId) ?? null;
  }

  async markWhatsappValidated(
    offerId: string,
    params: { possuiWhatsapp: boolean; telefoneUsado: string }
  ): Promise<void> {
    const offer = this.offers.get(offerId);
    if (!offer) throw new Error("oferta não encontrada");
    offer.status = params.possuiWhatsapp ? "AGUARDANDO_ROTEAMENTO" : "SEM_WHATSAPP";
    offer.telefoneValidado = params.possuiWhatsapp ? params.telefoneUsado : null;
    offer.whatsappRequestId = null;
    offer.whatsappCheckIniciadoEm = null;
  }

  async markWhatsappFailed(
    offerId: string,
    params: { proximaTentativaEm: Date | null; cancelar: boolean }
  ): Promise<void> {
    const offer = this.offers.get(offerId);
    if (!offer) throw new Error("oferta não encontrada");
    offer.status = params.cancelar ? "CANCELADO" : "ERRO_VALIDACAO_WHATSAPP";
    offer.tentativasWhatsapp += 1;
    offer.whatsappRequestId = null;
    offer.whatsappCheckIniciadoEm = null;
  }
}

describe("handleWhatsappValidacaoWebhook", () => {
  it("rejeita quando o token da querystring não confere", async () => {
    const port = new FakeWhatsappPort();

    const outcome = await handleWhatsappValidacaoWebhook(port as unknown as WhatsappValidationPort, port, {
      token: "token-errado",
      expectedToken: TOKEN,
      body: { request_id: "req-1", has_whatsapp: true },
    });

    expect(outcome.kind).toBe("invalid_token");
  });

  it("rejeita quando request_id está ausente", async () => {
    const port = new FakeWhatsappPort();

    const outcome = await handleWhatsappValidacaoWebhook(port as unknown as WhatsappValidationPort, port, {
      token: TOKEN,
      expectedToken: TOKEN,
      body: { request_id: "" } as any,
    });

    expect(outcome.kind).toBe("request_id_ausente");
  });

  it("responde oferta_nao_encontrada quando o request_id não corresponde a nenhuma oferta", async () => {
    const port = new FakeWhatsappPort();

    const outcome = await handleWhatsappValidacaoWebhook(port as unknown as WhatsappValidationPort, port, {
      token: TOKEN,
      expectedToken: TOKEN,
      body: { request_id: "req-inexistente", has_whatsapp: true },
    });

    expect(outcome.kind).toBe("oferta_nao_encontrada");
  });

  it("marca a oferta como validada (possui WhatsApp) e avança para AGUARDANDO_ROTEAMENTO", async () => {
    const port = new FakeWhatsappPort();
    port.addOffer({ id: "offer-1", whatsappRequestId: "req-1", telefoneOriginal: "62999999999" });

    const outcome = await handleWhatsappValidacaoWebhook(port as unknown as WhatsappValidationPort, port, {
      token: TOKEN,
      expectedToken: TOKEN,
      body: { request_id: "req-1", has_whatsapp: true },
    });

    expect(outcome).toEqual({ kind: "processed", offerId: "offer-1" });
    const offer = port.offers.get("offer-1");
    expect(offer?.status).toBe("AGUARDANDO_ROTEAMENTO");
    expect(offer?.telefoneValidado).toBe("62999999999");
    expect(offer?.whatsappRequestId).toBeNull();
  });

  it("marca a oferta como SEM_WHATSAPP quando has_whatsapp é false", async () => {
    const port = new FakeWhatsappPort();
    port.addOffer({ id: "offer-2", whatsappRequestId: "req-2", telefoneOriginal: "62988887777" });

    const outcome = await handleWhatsappValidacaoWebhook(port as unknown as WhatsappValidationPort, port, {
      token: TOKEN,
      expectedToken: TOKEN,
      body: { request_id: "req-2", has_whatsapp: false },
    });

    expect(outcome.kind).toBe("processed");
    expect(port.offers.get("offer-2")?.status).toBe("SEM_WHATSAPP");
  });

  it("agenda nova tentativa (sem cancelar) quando a CorbanTech reporta erro no callback", async () => {
    const port = new FakeWhatsappPort();
    port.addOffer({ id: "offer-3", whatsappRequestId: "req-3", telefoneOriginal: "62999999999" });

    const outcome = await handleWhatsappValidacaoWebhook(port as unknown as WhatsappValidationPort, port, {
      token: TOKEN,
      expectedToken: TOKEN,
      body: { request_id: "req-3", error: true, message: "telefone_invalido" },
    });

    expect(outcome.kind).toBe("processed");
    const offer = port.offers.get("offer-3");
    expect(offer?.status).toBe("ERRO_VALIDACAO_WHATSAPP");
    expect(offer?.tentativasWhatsapp).toBe(1);
  });
});
