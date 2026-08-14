import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAdminAuth } from "./auth";

function fakeReply() {
  const calls: Array<{ code?: number; body?: unknown }> = [];
  const reply = {
    code(code: number) {
      calls.push({ code });
      return reply;
    },
    send(body: unknown) {
      calls[calls.length - 1] = { ...calls[calls.length - 1], body };
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, calls };
}

function fakeRequest(authorization?: string): FastifyRequest {
  return { headers: { authorization } } as unknown as FastifyRequest;
}

describe("requireAdminAuth", () => {
  const ORIGINAL_ENV = process.env.ADMIN_API_TOKEN;

  beforeEach(() => {
    process.env.ADMIN_API_TOKEN = "segredo-admin";
  });

  afterEach(() => {
    process.env.ADMIN_API_TOKEN = ORIGINAL_ENV;
  });

  it("rejeita quando não há header Authorization", async () => {
    const { reply, calls } = fakeReply();
    await requireAdminAuth(fakeRequest(undefined), reply);
    expect(calls[0]).toEqual({ code: 401, body: { error: "nao_autorizado" } });
  });

  it("rejeita token incorreto", async () => {
    const { reply, calls } = fakeReply();
    await requireAdminAuth(fakeRequest("Bearer token-errado"), reply);
    expect(calls[0]?.code).toBe(401);
  });

  it("aceita o token correto sem chamar reply (deixa a rota seguir)", async () => {
    const { reply, calls } = fakeReply();
    await requireAdminAuth(fakeRequest("Bearer segredo-admin"), reply);
    expect(calls).toHaveLength(0);
  });

  it("rejeita qualquer token quando ADMIN_API_TOKEN não está configurado", async () => {
    delete process.env.ADMIN_API_TOKEN;
    const { reply, calls } = fakeReply();
    await requireAdminAuth(fakeRequest("Bearer qualquer-coisa"), reply);
    expect(calls[0]?.code).toBe(401);
  });
});
