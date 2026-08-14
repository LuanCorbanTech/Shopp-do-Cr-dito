import { describe, expect, it } from "vitest";
import { runReconciliationWorkerOnce } from "./worker6-reconciliation";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

describe("runReconciliationWorkerOnce", () => {
  it("libera ofertas travadas há mais tempo que o SLA de volta ao estado reprocessável", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      status: "EM_PROCESSAMENTO_ENVIO",
      reservedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    await runReconciliationWorkerOnce({ reconciliationPort: repo, slaMs: 10 * 60 * 1000 });

    expect(repo.offers.get(offer.id)?.status).toBe("AGUARDANDO_ENVIO");
  });

  it("não toca em ofertas travadas há menos tempo que o SLA", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      status: "PROCESSANDO_TELEFONE",
      reservedAt: new Date(Date.now() - 60 * 1000),
    });

    await runReconciliationWorkerOnce({ reconciliationPort: repo, slaMs: 10 * 60 * 1000 });

    expect(repo.offers.get(offer.id)?.status).toBe("PROCESSANDO_TELEFONE");
  });

  it("não toca em ofertas em processamento normal (reservedAt nulo)", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "AGUARDANDO_ENVIO" });

    await runReconciliationWorkerOnce({ reconciliationPort: repo, slaMs: 10 * 60 * 1000 });

    expect(repo.offers.get(offer.id)?.status).toBe("AGUARDANDO_ENVIO");
  });
});
