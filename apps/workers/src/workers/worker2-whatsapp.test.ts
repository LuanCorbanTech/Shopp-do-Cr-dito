import { describe, expect, it } from "vitest";
import { runWhatsappWorkerOnce } from "./worker2-whatsapp";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

describe("runWhatsappWorkerOnce", () => {
  it("avança para AGUARDANDO_ROTEAMENTO quando possui WhatsApp", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", telefoneAtualizado: "5562999999999", status: "TELEFONE_ATUALIZADO" });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: { validate: async () => ({ possuiWhatsapp: true, respostaBruta: null }) },
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("AGUARDANDO_ROTEAMENTO");
    expect(updated?.telefoneValidado).toBe("5562999999999");
  });

  it("usa telefone_original quando não houve consulta ao Limit", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "TELEFONE_ATUALIZADO" });

    let telefoneRecebido: string | null = null;
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        validate: async (telefone) => {
          telefoneRecebido = telefone;
          return { possuiWhatsapp: true, respostaBruta: null };
        },
      },
    });

    expect(telefoneRecebido).toBe("62999999999");
    expect(repo.offers.get(offer.id)?.telefoneValidado).toBe("62999999999");
  });

  it("encerra em SEM_WHATSAPP (estado terminal) quando não possui WhatsApp", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "TELEFONE_ATUALIZADO" });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: { validate: async () => ({ possuiWhatsapp: false, respostaBruta: null }) },
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("SEM_WHATSAPP");
    expect(updated?.telefoneValidado).toBeNull();
  });
});
