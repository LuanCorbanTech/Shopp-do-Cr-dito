import { describe, expect, it } from "vitest";
import { runWhatsappWorkerOnce } from "./worker2-whatsapp";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

// A API de validação da CorbanTech é assíncrona (docs/integrations/
// APIValidacaoWhatsAppCorbanTech.pdf): startCheck só devolve um request_id; o
// resultado é buscado depois via getCheckResult. Por isso estes testes chamam
// runWhatsappWorkerOnce duas vezes: a 1ª inicia a consulta (fase 1), a 2ª simula o
// fallback manual (fase 2) já encontrando o resultado disponível.

describe("runWhatsappWorkerOnce", () => {
  it("inicia a consulta e avança para AGUARDANDO_ROTEAMENTO quando o resultado (buscado depois) possui WhatsApp", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      telefoneAtualizado: "5562999999999",
      status: "TELEFONE_ATUALIZADO",
    });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-1", phone }),
        getCheckResult: async () => ({ status: "processing" }),
      },
    });

    let updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("VALIDANDO_WHATSAPP");
    expect(updated?.whatsappRequestId).toBe("req-1");

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-1", phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: true }),
      },
      awaitingResultTimeoutMs: 0,
      now: new Date(Date.now() + 1000),
    });

    updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("AGUARDANDO_ROTEAMENTO");
    expect(updated?.telefoneValidado).toBe("5562999999999");
    expect(updated?.whatsappRequestId).toBeNull();
  });

  it("usa telefone_original quando não houve consulta ao Limit", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "TELEFONE_ATUALIZADO" });

    let telefoneRecebido: string | null = null;
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        startCheck: async ({ phone }) => {
          telefoneRecebido = phone;
          return { requestId: "req-2", phone };
        },
        getCheckResult: async () => ({ status: "processing" }),
      },
    });

    expect(telefoneRecebido).toBe("62999999999");
    expect(repo.offers.get(offer.id)?.status).toBe("VALIDANDO_WHATSAPP");
  });

  it("encerra em SEM_WHATSAPP (estado terminal) quando o resultado indica que não possui WhatsApp", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "TELEFONE_ATUALIZADO" });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-3", phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: false }),
      },
    });
    expect(repo.offers.get(offer.id)?.status).toBe("VALIDANDO_WHATSAPP");

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-3", phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: false }),
      },
      awaitingResultTimeoutMs: 0,
      now: new Date(Date.now() + 1000),
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("SEM_WHATSAPP");
    expect(updated?.telefoneValidado).toBeNull();
  });

  it("mantém em VALIDANDO_WHATSAPP sem incrementar tentativas enquanto o resultado ainda está 'processing'", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "TELEFONE_ATUALIZADO" });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-4", phone }),
        getCheckResult: async () => ({ status: "processing" }),
      },
    });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-4", phone }),
        getCheckResult: async () => ({ status: "processing" }),
      },
      awaitingResultTimeoutMs: 0,
      now: new Date(Date.now() + 1000),
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("VALIDANDO_WHATSAPP");
    expect(updated?.tentativasWhatsapp).toBe(0);
  });

  it("agenda nova tentativa (sem cancelar) quando falha ao iniciar a consulta", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "TELEFONE_ATUALIZADO" });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService: {
        startCheck: async () => {
          throw new Error("timeout ao iniciar consulta");
        },
        getCheckResult: async () => ({ status: "processing" }),
      },
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("ERRO_VALIDACAO_WHATSAPP");
    expect(updated?.tentativasWhatsapp).toBe(1);
    expect(updated?.proximaTentativaEm).not.toBeNull();
  });
});
