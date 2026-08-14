import { describe, expect, it, beforeAll, afterAll } from "vitest";
import IORedis from "ioredis";
import { runDispatchWorkerOnce } from "./worker4-dispatch";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

// Testes de integração reais contra Redis (rate limiting) — requer REDIS_URL.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: IORedis;

beforeAll(() => {
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await redis.quit();
});

function endpoint(overrides: Partial<Parameters<InMemoryPipelineRepository["addEndpoint"]>[0]> = {}) {
  return {
    id: "endpoint-1",
    nome: "Endpoint 1",
    url: "https://example.com/dispatch",
    metodoHttp: "POST",
    headers: null,
    authType: "NONE",
    credenciaisRef: null,
    capacidadeMinuto: null,
    capacidadeHora: 2,
    capacidadeDia: null,
    timeoutMs: 5000,
    maxTentativas: 3,
    ativo: true,
    ...overrides,
  };
}

describe("runDispatchWorkerOnce", () => {
  it("dispara ofertas AGUARDANDO_ENVIO e marca ENVIADO em caso de sucesso", async () => {
    const repo = new InMemoryPipelineRepository();
    const ep = endpoint({ id: `endpoint-${Date.now()}-a` });
    repo.addEndpoint(ep);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "AGUARDANDO_ENVIO", endpointId: ep.id });

    await runDispatchWorkerOnce({
      dispatchPort: repo,
      hyperflowService: { dispatch: async () => ({ sucesso: true, httpStatus: 200, request: {}, respostaBruta: { ok: true } }) },
      redis,
    });

    expect(repo.offers.get(offer.id)?.status).toBe("ENVIADO");
  });

  it("respeita a capacidade por hora do endpoint (rate limiting real via Redis)", async () => {
    const repo = new InMemoryPipelineRepository();
    const ep = endpoint({ id: `endpoint-${Date.now()}-b`, capacidadeHora: 2 });
    repo.addEndpoint(ep);
    const offers = [
      repo.addOffer({ telefoneOriginal: "62999999991", status: "AGUARDANDO_ENVIO", endpointId: ep.id }),
      repo.addOffer({ telefoneOriginal: "62999999992", status: "AGUARDANDO_ENVIO", endpointId: ep.id }),
      repo.addOffer({ telefoneOriginal: "62999999993", status: "AGUARDANDO_ENVIO", endpointId: ep.id }),
    ];

    await runDispatchWorkerOnce({
      dispatchPort: repo,
      hyperflowService: { dispatch: async () => ({ sucesso: true, httpStatus: 200, request: {}, respostaBruta: {} }) },
      redis,
    });

    const statuses = offers.map((o) => repo.offers.get(o.id)?.status);
    // capacidadeHora=2 e 3 ofertas na fila: exatamente 2 devem ser enviadas nesta
    // passada e a 3ª deve permanecer aguardando a próxima janela — nunca as 3.
    expect(statuses.filter((s) => s === "ENVIADO")).toHaveLength(2);
    expect(statuses.filter((s) => s === "AGUARDANDO_ENVIO")).toHaveLength(1);
  });

  it("agenda retry (ERRO_ENVIO) quando o disparo falha e ainda há tentativas", async () => {
    const repo = new InMemoryPipelineRepository();
    const ep = endpoint({ id: `endpoint-${Date.now()}-c`, maxTentativas: 5 });
    repo.addEndpoint(ep);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "AGUARDANDO_ENVIO", endpointId: ep.id });

    await runDispatchWorkerOnce({
      dispatchPort: repo,
      hyperflowService: { dispatch: async () => ({ sucesso: false, httpStatus: 500, request: {}, respostaBruta: { erro: "timeout" } }) },
      redis,
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("ERRO_ENVIO");
    expect(updated?.tentativasEnvio).toBe(1);
  });
});
