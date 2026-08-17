import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { DispatchPollPort, OfferSnapshot } from "@plataforma-ofertas/domain";
import { registerAguardandoDisparoRoutes } from "./aguardando-disparo-routes";

const TOKEN = "segredo-do-endpoint-de-disparo";

function fakeOferta(overrides: Partial<OfferSnapshot> = {}): OfferSnapshot {
  return {
    id: "offer-1",
    webhookId: "webhook-1",
    externalId: "lead-externo-1",
    nome: "Lucas Mendes",
    cpf: "03073732152",
    dataNascimento: new Date("1990-02-03T02:00:00.000Z"),
    telefoneOriginal: "62993718537",
    telefoneAtualizado: "5562993718537",
    telefoneValidado: "5562993718537",
    possuiWhatsapp: true,
    bancoAutorizado: "C6",
    produto: "credito-pessoal",
    valor: 5000,
    parcelas: 12,
    status: "AGUARDANDO_DISPARO",
    routingRuleId: null,
    endpointId: null,
    tentativasTelefone: 0,
    tentativasWhatsapp: 0,
    tentativasEnvio: 0,
    whatsappRequestId: null,
    whatsappCheckIniciadoEm: null,
    ...overrides,
  };
}

class FakeDispatchPollPort implements DispatchPollPort {
  ofertasDisponiveis: OfferSnapshot[] = [];
  ultimoLimitPedido: number | null = null;

  async claimOffersAguardandoDisparo(limit: number): Promise<OfferSnapshot[]> {
    this.ultimoLimitPedido = limit;
    const consumidas = this.ofertasDisponiveis.slice(0, limit);
    // simula o consumo atômico: uma vez lida, não aparece mais.
    this.ofertasDisponiveis = this.ofertasDisponiveis.slice(limit);
    return consumidas;
  }
}

function buildApp(port: DispatchPollPort, token: string | undefined) {
  const app = Fastify();
  registerAguardandoDisparoRoutes(app, port, token);
  return app;
}

describe("GET /api/v1/leads/aguardando-disparo", () => {
  it("devolve 503 quando DISPATCH_API_TOKEN não está configurado", async () => {
    const app = buildApp(new FakeDispatchPollPort(), undefined);
    const res = await app.inject({ method: "GET", url: "/api/v1/leads/aguardando-disparo" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("servico_indisponivel");
  });

  it("devolve 401 sem header Authorization", async () => {
    const app = buildApp(new FakeDispatchPollPort(), TOKEN);
    const res = await app.inject({ method: "GET", url: "/api/v1/leads/aguardando-disparo" });
    expect(res.statusCode).toBe(401);
  });

  it("devolve 401 com token errado", async () => {
    const app = buildApp(new FakeDispatchPollPort(), TOKEN);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leads/aguardando-disparo",
      headers: { authorization: "Bearer token-errado" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("devolve as ofertas com todos os campos pedidos, com token correto", async () => {
    const port = new FakeDispatchPollPort();
    port.ofertasDisponiveis = [fakeOferta()];
    const app = buildApp(port, TOKEN);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leads/aguardando-disparo",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.leads).toHaveLength(1);
    expect(body.leads[0]).toMatchObject({
      id: "offer-1",
      nome: "Lucas Mendes",
      cpf: "03073732152",
      dataNascimento: "1990-02-03T02:00:00.000Z",
      telefoneWhatsapp: "5562993718537",
      possuiWhatsapp: true,
    });
  });

  it("usa limit=50 por padrão e respeita o teto de 200", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, TOKEN);

    await app.inject({
      method: "GET",
      url: "/api/v1/leads/aguardando-disparo",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(port.ultimoLimitPedido).toBe(50);

    await app.inject({
      method: "GET",
      url: "/api/v1/leads/aguardando-disparo?limit=9999",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(port.ultimoLimitPedido).toBe(200);
  });

  it("uma vez lida, a mesma oferta não aparece de novo na chamada seguinte", async () => {
    const port = new FakeDispatchPollPort();
    port.ofertasDisponiveis = [fakeOferta({ id: "offer-1" })];
    const app = buildApp(port, TOKEN);

    const primeira = await app.inject({
      method: "GET",
      url: "/api/v1/leads/aguardando-disparo",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(primeira.json().total).toBe(1);

    const segunda = await app.inject({
      method: "GET",
      url: "/api/v1/leads/aguardando-disparo",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(segunda.json().total).toBe(0);
  });
});
