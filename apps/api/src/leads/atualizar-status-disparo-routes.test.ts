import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { DispatchPollPort } from "@plataforma-ofertas/domain";
import { registerAtualizarStatusDisparoRoutes } from "./atualizar-status-disparo-routes";
import { fakeOferta, FakeDispatchPollPort } from "./fake-dispatch-poll-port";

const TOKEN = "segredo-do-endpoint-de-disparo";

function buildApp(port: DispatchPollPort, token: string | undefined) {
  const app = Fastify();
  registerAtualizarStatusDisparoRoutes(app, port, token);
  return app;
}

describe("POST /api/v1/leads/status", () => {
  it("atualiza pra DISPARO_ENVIADO buscando por id", async () => {
    const port = new FakeDispatchPollPort();
    const oferta = fakeOferta({ id: "offer-1", status: "DISPARO_CONSULTADO" });
    port.ofertasPorChave.set("offer-1", oferta);
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/leads/status",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "offer-1", status: "enviado" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "atualizado", id: "offer-1", novoStatus: "DISPARO_ENVIADO" });
  });

  it("atualiza pra DISPARO_RESPONDIDO buscando por externalId (sem ter o id nosso)", async () => {
    const port = new FakeDispatchPollPort();
    const oferta = fakeOferta({ id: "offer-2", externalId: "lead-externo-2", status: "DISPARO_ENVIADO" });
    port.ofertasPorChave.set("lead-externo-2", oferta);
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/leads/status",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { externalId: "lead-externo-2", status: "respondido" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "atualizado", id: "offer-2", novoStatus: "DISPARO_RESPONDIDO" });
  });

  it("devolve 404 quando não acha o lead (id/externalId inexistente)", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/leads/status",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "nao-existe", status: "enviado" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "lead_nao_encontrado" });
  });

  it("devolve 400 quando não manda nem id nem externalId", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/leads/status",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { status: "enviado" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("identificador_obrigatorio");
  });

  it('devolve 400 quando "status" não é "enviado" nem "respondido"', async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/leads/status",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "offer-1", status: "qualquer-coisa" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("status_invalido");
  });

  it("rejeita sem o Bearer token correto", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, TOKEN);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/leads/status",
      headers: { authorization: "Bearer token-errado" },
      payload: { id: "offer-1", status: "enviado" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devolve 503 se o token nunca foi configurado no servidor (undefined)", async () => {
    const port = new FakeDispatchPollPort();
    const app = buildApp(port, undefined);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/leads/status",
      headers: { authorization: "Bearer qualquer-coisa" },
      payload: { id: "offer-1", status: "enviado" },
    });

    expect(response.statusCode).toBe(503);
  });
});
