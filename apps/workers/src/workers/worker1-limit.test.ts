import { describe, expect, it } from "vitest";
import { runLimitWorkerOnce } from "./worker1-limit";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

describe("runLimitWorkerOnce", () => {
  it("usa o telefone original e ignora o Limit quando desativado (item 8)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", false);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999" });

    let called = false;
    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async () => {
          called = true;
          return { telefoneAtualizado: "5562999999999", respostaBruta: null };
        },
      },
    });

    expect(called).toBe(false);
    expect(repo.offers.get(offer.id)?.status).toBe("TELEFONE_ATUALIZADO");
    expect(repo.offers.get(offer.id)?.telefoneAtualizado).toBeNull();
  });

  it("chama o Limit e grava o telefone atualizado quando ativado", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999" });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async () => ({ telefoneAtualizado: "5562999999999", respostaBruta: { ok: true } }),
      },
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("TELEFONE_ATUALIZADO");
    expect(updated?.telefoneAtualizado).toBe("5562999999999");
  });

  it("agenda retry (não cancela) quando ainda há tentativas disponíveis", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true, { maxTentativas: 3 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999" });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => { throw new Error("timeout"); } },
      now: new Date("2026-08-14T12:00:00Z"),
    });

    const failed = repo.offers.get(offer.id);
    expect(failed?.status).toBe("ERRO_TELEFONE");
    expect(failed?.tentativasTelefone).toBe(1);
    expect(failed?.proximaTentativaEm).not.toBeNull();
  });

  it("cancela ao esgotar o número máximo de tentativas — nunca é retry infinito", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true, { maxTentativas: 1 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999" });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => { throw new Error("timeout"); } },
    });

    const failed = repo.offers.get(offer.id);
    expect(failed?.status).toBe("CANCELADO");
    expect(failed?.proximaTentativaEm).toBeNull();
  });
});
