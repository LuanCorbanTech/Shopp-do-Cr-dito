import { describe, expect, it } from "vitest";
import { runWhatsappWorkerOnce } from "./worker2-whatsapp";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

// A API de validação da CorbanTech é assíncrona (docs/integrations/
// APIValidacaoWhatsAppCorbanTech.pdf): startCheck só devolve um request_id; o
// resultado é buscado depois via getCheckResult. Por isso estes testes chamam
// runWhatsappWorkerOnce duas vezes: a 1ª inicia a consulta (fase 1), a 2ª simula o
// fallback manual (fase 2) já encontrando o resultado disponível.

describe("runWhatsappWorkerOnce", () => {
  it("inicia a consulta e avança para AGUARDANDO_DISPARO quando o resultado (buscado depois) possui WhatsApp", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      telefoneAtualizado: "5562999999999",
      status: "TELEFONE_ATUALIZADO",
    });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-1", phone }),
        getCheckResult: async () => ({ status: "processing" }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
      },
    });

    let updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("VALIDANDO_WHATSAPP");
    expect(updated?.whatsappRequestId).toBe("req-1");

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-1", phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: true }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
      },
      awaitingResultTimeoutMs: 0,
      now: new Date(Date.now() + 1000),
    });

    updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("AGUARDANDO_DISPARO");
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
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => {
          telefoneRecebido = phone;
          return { requestId: "req-2", phone };
        },
        getCheckResult: async () => ({ status: "processing" }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
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
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-3", phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: false }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
      },
    });
    expect(repo.offers.get(offer.id)?.status).toBe("VALIDANDO_WHATSAPP");

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-3", phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: false }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
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
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-4", phone }),
        getCheckResult: async () => ({ status: "processing" }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
      },
    });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: "req-4", phone }),
        getCheckResult: async () => ({ status: "processing" }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
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
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async () => {
          throw new Error("timeout ao iniciar consulta");
        },
        getCheckResult: async () => ({ status: "processing" }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
      },
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("ERRO_VALIDACAO_WHATSAPP");
    expect(updated?.tentativasWhatsapp).toBe(1);
    expect(updated?.proximaTentativaEm).not.toBeNull();
  });

  it("cancela (sem chamar a API) quando não existe nenhum telefone disponível", async () => {
    const repo = new InMemoryPipelineRepository();
    // Lead sem telefone na captação e sem telefone_atualizado — cenário possível
    // desde que o telefone deixou de ser obrigatório na captação (só o CPF é).
    const offer = repo.addOffer({ telefoneOriginal: null, status: "TELEFONE_ATUALIZADO" });

    let chamouApi = false;
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => {
          chamouApi = true;
          return { requestId: "nao-deveria-chamar", phone };
        },
        getCheckResult: async () => ({ status: "processing" }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
      },
    });

    expect(chamouApi).toBe(false);
    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("CANCELADO");
  });
});

describe("runWhatsappWorkerOnce — caminho de LOTE (checknumber.ai, mínimo 500)", () => {
  function servicoDeLoteFalso(overrides: Partial<{
    startCheckLote: () => Promise<{ loteId: string; total: number }>;
    getCheckResultLote: (loteId: string) => Promise<{ status: "processing" | "done" | "error"; resultados?: { telefone: string; possuiWhatsapp: boolean }[]; message?: string }>;
  }> = {}) {
    return {
      startCheck: async () => { throw new Error("startCheck (individual) não deveria ser chamado neste teste de lote"); },
      getCheckResult: async () => { throw new Error("getCheckResult (individual) não deveria ser chamado neste teste de lote"); },
      startCheckLote: overrides.startCheckLote ?? (async () => ({ loteId: "lote-1", total: 500 })),
      getCheckResultLote: overrides.getCheckResultLote ?? (async () => ({ status: "processing" as const })),
    };
  }

  it("não faz nada enquanto não junta o mínimo, dentro do prazo aceitável (não é bug, é esperado)", async () => {
    const repo = new InMemoryPipelineRepository();
    // Só 3 ofertas — bem abaixo do mínimo de 500 — e dentro do prazo (não passou tempoMaximoEsperaLoteMs).
    for (let i = 0; i < 3; i++) repo.addOffer({ telefoneOriginal: "62999999999", status: "TELEFONE_ATUALIZADO" });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 500,
      tempoMaximoEsperaLoteMs: 2 * 60 * 60 * 1000, // 2h — bem longe de estourar num teste que roda em milissegundos
      whatsappService: servicoDeLoteFalso(),
    });

    // Nenhuma das 3 ofertas deveria ter sido tocada — continuam esperando.
    for (const offer of repo.offers.values()) {
      expect(offer.status).toBe("TELEFONE_ATUALIZADO");
    }
  });

  it("dispara o lote assim que junta o mínimo — marca todas com o mesmo loteId e status VALIDANDO_WHATSAPP", async () => {
    const repo = new InMemoryPipelineRepository();
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      const o = repo.addOffer({ telefoneOriginal: `6299999${String(i).padStart(4, "0")}`, status: "TELEFONE_ATUALIZADO" });
      ids.push(o.id);
    }

    let telefonesRecebidos: string[] = [];
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 500,
      whatsappService: servicoDeLoteFalso({
        startCheckLote: async () => {
          throw new Error("não deveria chegar aqui sem capturar phones"); // será substituído abaixo
        },
      }) as never,
    }).catch(() => {}); // primeira chamada só pra não quebrar o helper acima — refeita corretamente logo abaixo

    // Chamada de verdade, capturando os telefones enviados:
    const repo2 = new InMemoryPipelineRepository();
    for (let i = 0; i < 500; i++) {
      repo2.addOffer({ telefoneOriginal: `6299999${String(i).padStart(4, "0")}`, status: "TELEFONE_ATUALIZADO" });
    }
    await runWhatsappWorkerOnce({
      whatsappPort: repo2,
      configPort: repo2,
      loteMinimo: 500,
      whatsappService: {
        startCheck: async () => { throw new Error("não deveria chamar o individual"); },
        getCheckResult: async () => { throw new Error("não deveria chamar o individual"); },
        startCheckLote: async ({ phones }) => {
          telefonesRecebidos = phones;
          return { loteId: "lote-abc", total: phones.length };
        },
        getCheckResultLote: async () => ({ status: "processing" }),
      },
    });

    expect(telefonesRecebidos.length).toBe(500);
    const ofertas = [...repo2.offers.values()];
    expect(ofertas.every((o) => o.status === "VALIDANDO_WHATSAPP")).toBe(true);
    expect(ofertas.every((o) => o.whatsappLoteId === "lote-abc")).toBe(true);
  });

  it("distribui o resultado do lote corretamente — cada telefone recebe o próprio resultado (misto: com e sem WhatsApp)", async () => {
    const repo = new InMemoryPipelineRepository();
    const ofertas = Array.from({ length: 500 }, (_, i) =>
      repo.addOffer({ telefoneOriginal: `6299999${String(i).padStart(4, "0")}`, status: "TELEFONE_ATUALIZADO" })
    );

    // Fase 1: dispara o lote
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 500,
      whatsappService: {
        startCheck: async () => { throw new Error("não deveria chamar"); },
        getCheckResult: async () => { throw new Error("não deveria chamar"); },
        startCheckLote: async ({ phones }) => ({ loteId: "lote-misto", total: phones.length }),
        getCheckResultLote: async () => ({ status: "processing" }),
      },
    });

    // Fase 2-B: resultado sai — os 3 primeiros telefones têm WhatsApp, o resto não.
    const telefonesComWhatsapp = new Set(
      ofertas.slice(0, 3).map((o) => o.telefoneOriginal as string)
    );
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 500,
      awaitingResultTimeoutMs: -60000, // negativo com folga -- evita sensibilidade de 1ms no relógio do sandbox
      whatsappService: {
        startCheck: async () => { throw new Error("não deveria chamar"); },
        getCheckResult: async () => { throw new Error("não deveria chamar"); },
        startCheckLote: async () => { throw new Error("não deveria disparar outro lote — ainda tem um pendente"); },
        getCheckResultLote: async (loteId) => {
          expect(loteId).toBe("lote-misto");
          return {
            status: "done",
            resultados: ofertas.map((o) => ({
              telefone: o.telefoneOriginal as string,
              possuiWhatsapp: telefonesComWhatsapp.has(o.telefoneOriginal as string),
            })),
          };
        },
      },
    });

    const atualizadas = [...repo.offers.values()];
    const comWhatsapp = atualizadas.filter((o) => o.status === "AGUARDANDO_DISPARO");
    const semWhatsapp = atualizadas.filter((o) => o.status === "SEM_WHATSAPP");
    expect(comWhatsapp.length).toBe(3);
    expect(semWhatsapp.length).toBe(497);
  });

  it("quando o lote INTEIRO falha, agenda retry (ou cancela) pra cada oferta do lote — mesma lógica de backoff do caminho individual", async () => {
    const repo = new InMemoryPipelineRepository();
    for (let i = 0; i < 500; i++) {
      repo.addOffer({ telefoneOriginal: `6299999${String(i).padStart(4, "0")}`, status: "TELEFONE_ATUALIZADO" });
    }

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 500,
      whatsappService: {
        startCheck: async () => { throw new Error("não deveria chamar"); },
        getCheckResult: async () => { throw new Error("não deveria chamar"); },
        startCheckLote: async () => ({ loteId: "lote-vai-falhar", total: 500 }),
        getCheckResultLote: async () => ({ status: "processing" }),
      },
    });

    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 500,
      awaitingResultTimeoutMs: -60000, // negativo com folga -- evita sensibilidade de 1ms no relógio do sandbox
      whatsappService: {
        startCheck: async () => { throw new Error("não deveria chamar"); },
        getCheckResult: async () => { throw new Error("não deveria chamar"); },
        startCheckLote: async () => { throw new Error("não deveria disparar outro lote"); },
        getCheckResultLote: async () => ({ status: "error", message: "checknumber.ai fora do ar" }),
      },
    });

    const atualizadas = [...repo.offers.values()];
    expect(atualizadas.every((o) => o.status === "ERRO_VALIDACAO_WHATSAPP")).toBe(true);
    expect(atualizadas.every((o) => o.tentativasWhatsapp === 1)).toBe(true);
  });

  it("ofertas sem telefone nenhum são tiradas do lote e canceladas individualmente — o resto segue pro lote normalmente", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.addOffer({ telefoneOriginal: null, status: "TELEFONE_ATUALIZADO" }); // sem telefone
    for (let i = 0; i < 499; i++) {
      repo.addOffer({ telefoneOriginal: `6299999${String(i).padStart(4, "0")}`, status: "TELEFONE_ATUALIZADO" });
    }

    let totalNoLote = 0;
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 500,
      whatsappService: {
        startCheck: async () => { throw new Error("não deveria chamar"); },
        getCheckResult: async () => { throw new Error("não deveria chamar"); },
        startCheckLote: async ({ phones }) => {
          totalNoLote = phones.length;
          return { loteId: "lote-com-um-sem-telefone", total: phones.length };
        },
        getCheckResultLote: async () => ({ status: "processing" }),
      },
    });

    expect(totalNoLote).toBe(499); // a sem telefone não entrou no lote
    const canceladas = [...repo.offers.values()].filter((o) => o.status === "CANCELADO");
    expect(canceladas.length).toBe(1);
    const noLote = [...repo.offers.values()].filter((o) => o.status === "VALIDANDO_WHATSAPP");
    expect(noLote.length).toBe(499);
  });
});
