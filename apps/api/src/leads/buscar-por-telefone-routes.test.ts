import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { DispatchPollPort } from "@plataforma-ofertas/domain";
import { registerBuscarPorTelefoneRoutes } from "./buscar-por-telefone-routes";
import { fakeOferta, FakeDispatchPollPort } from "./fake-dispatch-poll-port";

const TOKEN = "segredo-do-endpoint-de-disparo";

function buildApp(port: DispatchPollPort, token: string | undefined) {
  const app = Fastify();
  registerBuscarPorTelefoneRoutes(app, port, token);
  return app;
}

describe("GET /api/v1/leads/buscar-por-telefone", () => {
  it("acha a oferta e devolve os campos certos (mesmo formato do GET /aguardando-disparo)", async () => {
    const port = new FakeDispatchPollPort();
    const oferta = fakeOferta({
      id: "offer-1",
      externalId: "lead-99",
      nome: "Lucas Mendes",
      cpf: "03073732152",
      telefoneValidado: "5562993718537",
      status: "DISPARO_RESPONDIDO",
    });
    port.ofertasPorChave.set("offer-1", oferta);
    port.origemPorOfertaId.set("offer-1", "Leilão de Crédito");
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/leads/buscar-por-telefone?telefone=5562993718537",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "offer-1",
      externalId: "lead-99",
      nome: "Lucas Mendes",
      cpf: "03073732152",
      dataNascimento: "1990-02-03T02:00:00.000Z",
      telefoneWhatsapp: "5562993718537",
      possuiWhatsapp: true,
      bancoAutorizado: "C6",
      produto: "credito-pessoal",
      valor: 5000,
      parcelas: 12,
      status: "DISPARO_RESPONDIDO",
      origem: "Leilão de Crédito",
    });
  });

  it("campo 'origem' (04/09, pedido explícito) — devolve o nome do parceiro/webhook de onde o lead veio", async () => {
    const port = new FakeDispatchPollPort();
    const oferta = fakeOferta({ id: "offer-2", telefoneValidado: "5511999999999" });
    port.ofertasPorChave.set("offer-2", oferta);
    port.origemPorOfertaId.set("offer-2", "Odysseia");
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/leads/buscar-por-telefone?telefone=5511999999999",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.json().origem).toBe("Odysseia");
  });

  it("aceita telefone SEM DDI (adiciona 55 sozinho antes de buscar)", async () => {
    const port = new FakeDispatchPollPort();
    const oferta = fakeOferta({ telefoneValidado: "5562993718537" });
    port.ofertasPorChave.set("offer-1", oferta);
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      // Sem o 55 na frente — só DDD + número (11 dígitos)
      url: "/api/v1/leads/buscar-por-telefone?telefone=62993718537",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it("aceita telefone com '+' e outros caracteres de formatação (limpa antes de comparar)", async () => {
    const port = new FakeDispatchPollPort();
    const oferta = fakeOferta({ telefoneValidado: "5562993718537" });
    port.ofertasPorChave.set("offer-1", oferta);
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/leads/buscar-por-telefone?telefone=${encodeURIComponent("+55 (62) 99371-8537")}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it("devolve 404 quando não acha nenhuma oferta com esse telefone", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/leads/buscar-por-telefone?telefone=5562999999999",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("nao_encontrado");
  });

  it("devolve 400 quando não manda o parâmetro telefone", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/leads/buscar-por-telefone",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("telefone_obrigatorio");
  });

  it("rejeita sem o Bearer token correto", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/leads/buscar-por-telefone?telefone=5562993718537",
      headers: { authorization: "Bearer token-errado" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devolve 503 se o token nunca foi configurado no servidor (undefined)", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, undefined);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/leads/buscar-por-telefone?telefone=5562993718537",
      headers: { authorization: "Bearer qualquer-coisa" },
    });

    expect(response.statusCode).toBe(503);
  });

  it("BUG REAL corrigido em 04/09: acha a oferta quando o telefone é passado SEM DDI e está gravado SEM DDI (caso real reportado — antes, a rota adicionava 55 e nunca batia)", async () => {
    const port = new FakeDispatchPollPort();
    const oferta = fakeOferta({ id: "offer-real", telefoneValidado: "62993929051" }); // exatamente como reportado, sem DDI
    port.ofertasPorChave.set("offer-real", oferta);
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/leads/buscar-por-telefone?telefone=62993929051",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe("offer-real");
  });

  it("também acha quando o telefone É passado COM o DDI (13 dígitos), mesmo o valor gravado estando sem", async () => {
    const port = new FakeDispatchPollPort();
    const oferta = fakeOferta({ id: "offer-real-2", telefoneValidado: "62993929051" });
    port.ofertasPorChave.set("offer-real-2", oferta);
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/leads/buscar-por-telefone?telefone=5562993929051", // com 55 na frente
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe("offer-real-2");
  });
});
