import { describe, expect, it } from "vitest";
import { runRetryWorkerOnce } from "./worker5-retry";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

describe("runRetryWorkerOnce", () => {
  it("devolve ERRO_ENVIO para AGUARDANDO_ENVIO quando a janela de backoff já passou", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      status: "ERRO_ENVIO",
      proximaTentativaEm: new Date(Date.now() - 1000),
    });

    await runRetryWorkerOnce({ retryPort: repo });

    expect(repo.offers.get(offer.id)?.status).toBe("AGUARDANDO_ENVIO");
  });

  it("não reprocessa antes da próxima tentativa agendada", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      status: "ERRO_TELEFONE",
      proximaTentativaEm: new Date(Date.now() + 60_000),
    });

    await runRetryWorkerOnce({ retryPort: repo });

    expect(repo.offers.get(offer.id)?.status).toBe("ERRO_TELEFONE");
  });

  it("mapeia cada estado de erro para o estado de reprocessamento correto", async () => {
    const repo = new InMemoryPipelineRepository();
    const telefone = repo.addOffer({ telefoneOriginal: "62999999999", status: "ERRO_TELEFONE" });
    const whatsapp = repo.addOffer({ telefoneOriginal: "62999999999", status: "ERRO_VALIDACAO_WHATSAPP" });
    const envio = repo.addOffer({ telefoneOriginal: "62999999999", status: "ERRO_ENVIO" });

    await runRetryWorkerOnce({ retryPort: repo });

    expect(repo.offers.get(telefone.id)?.status).toBe("RECEBIDO");
    expect(repo.offers.get(whatsapp.id)?.status).toBe("TELEFONE_ATUALIZADO");
    expect(repo.offers.get(envio.id)?.status).toBe("AGUARDANDO_ENVIO");
  });
});
