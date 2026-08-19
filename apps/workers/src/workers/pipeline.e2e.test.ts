import { describe, expect, it, beforeAll, afterAll } from "vitest";
import IORedis from "ioredis";
import { runLimitWorkerOnce } from "./worker1-limit";
import { runWhatsappWorkerOnce } from "./worker2-whatsapp";
import { runDispatchWorkerOnce } from "./worker4-dispatch";
import { runRetryWorkerOnce } from "./worker5-retry";
import { runReconciliationWorkerOnce } from "./worker6-reconciliation";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

// Teste de integração "ponta a ponta" (em memória): simula uma oferta atravessando
// os 6 workers na ordem descrita na seção 3/47 do doc de arquitetura, confirmando que
// o pipeline inteiro converge para ENVIADO. Não substitui um teste real contra
// Postgres/Redis+API externas, mas verifica que a orquestração dos workers entre si
// está coerente (cada um deixa a oferta exatamente no estado que o próximo espera).

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: IORedis;

beforeAll(() => {
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await redis.quit();
});

describe("pipeline completo (RECEBIDO -> AGUARDANDO_DISPARO)", () => {
  it("com Limit ativado e WhatsApp encontrado", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true);

    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      cpf: "85868388372",
      bancoAutorizado: "C6",
      status: "RECEBIDO",
    });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async () => ({
          telefoneAtualizado: "5562999999999",
          possuiWhatsappSegundoLemit: true,
          dadosPessoa: { data_nascimento: "1990-02-03T00:00:00-02:00" },
          respostaBruta: {},
        }),
      },
    });
    expect(repo.offers.get(offer.id)?.status).toBe("TELEFONE_ATUALIZADO");
    // A data de nascimento vem da Lemit e já fica salva na oferta desde essa etapa.
    expect(repo.offers.get(offer.id)?.dataNascimento?.toISOString()).toBe("1990-02-03T02:00:00.000Z");

    // A validação de WhatsApp é assíncrona (ver worker2-whatsapp.ts): a 1ª chamada só
    // inicia a consulta (request_id); a 2ª (fallback do fluxo, aqui simulando o
    // resultado já disponível) busca e resolve o resultado.
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => ({ requestId: `req-${offer.id}`, phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: true }),
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
        startCheck: async ({ phone }) => ({ requestId: `req-${offer.id}`, phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: true }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
      },
      awaitingResultTimeoutMs: 0,
      now: new Date(Date.now() + 1000),
    });
    // Novo modelo (17/08): sucesso na validação vai direto pra AGUARDANDO_DISPARO —
    // não existe mais motor de roteamento interno (Regras de Roteamento/Endpoints/
    // Worker de Disparo). Um sistema externo consulta essas ofertas via
    // GET /api/v1/leads/aguardando-disparo (ver dispatch-poll-routes.ts na API).
    const final = repo.offers.get(offer.id);
    expect(final?.status).toBe("AGUARDANDO_DISPARO");
    expect(final?.possuiWhatsapp).toBe(true);
    expect(final?.telefoneValidado).toBe("5562999999999");
  });

  it("com Limit desativado, telefone original é usado do início ao fim", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", false);

    const offer = repo.addOffer({ telefoneOriginal: "62988887777", bancoAutorizado: "BMG", status: "RECEBIDO" });

    await runLimitWorkerOnce({ phonePort: repo, configPort: repo, limitService: { lookupPhone: async () => { throw new Error("não deveria ser chamado"); } } });

    let telefoneRecebido: string | null = null;
    await runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      loteMinimo: 999999,
      tempoMaximoEsperaLoteMs: -60000,
      whatsappService: {
        startCheck: async ({ phone }) => {
          telefoneRecebido = phone;
          return { requestId: "req-bmg", phone };
        },
        getCheckResult: async () => ({ status: "done", hasWhatsapp: telefoneRecebido === "62988887777" }),
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
        startCheck: async ({ phone }) => ({ requestId: "req-bmg", phone }),
        getCheckResult: async () => ({ status: "done", hasWhatsapp: telefoneRecebido === "62988887777" }),
        startCheckLote: async () => { throw new Error("startCheckLote não deveria ser chamado neste teste"); },
        getCheckResultLote: async () => { throw new Error("getCheckResultLote não deveria ser chamado neste teste"); },
      },
      awaitingResultTimeoutMs: 0,
      now: new Date(Date.now() + 1000),
    });

    const final = repo.offers.get(offer.id);
    expect(final?.status).toBe("AGUARDANDO_DISPARO");
    expect(final?.telefoneAtualizado).toBeNull();
    expect(final?.telefoneValidado).toBe("62988887777");
  });

  // As duas próximas continuam testando worker3/4/5/6 isoladamente (código que
  // ainda existe no repositório, mas que nenhuma oferta real alcança mais desde
  // que o roteamento/disparo interno foi substituído pelo endpoint de polling
  // externo) — cobertura mantida caso esse código volte a ser usado.
  it("falha no disparo -> retry -> sucesso na segunda tentativa", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.addEndpoint({
      id: "endpoint-itau",
      nome: "Itaú",
      url: "https://example.com/itau",
      metodoHttp: "POST",
      headers: null,
      authType: "NONE",
      credenciaisRef: null,
      capacidadeMinuto: null,
      capacidadeHora: 1000,
      capacidadeDia: null,
      timeoutMs: 5000,
      maxTentativas: 5,
      ativo: true,
    });
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      status: "AGUARDANDO_ENVIO",
      endpointId: "endpoint-itau",
    });

    let attempt = 0;
    const hyperflowService = {
      dispatch: async () => {
        attempt += 1;
        if (attempt === 1) {
          return { sucesso: false, httpStatus: 500, request: {}, respostaBruta: { erro: "timeout" } };
        }
        return { sucesso: true, httpStatus: 200, request: {}, respostaBruta: {} };
      },
    };

    await runDispatchWorkerOnce({ dispatchPort: repo, hyperflowService, redis });
    expect(repo.offers.get(offer.id)?.status).toBe("ERRO_ENVIO");

    // libera para retry (simula proximaTentativaEm já no passado)
    repo.offers.get(offer.id)!.proximaTentativaEm = new Date(Date.now() - 1000);
    await runRetryWorkerOnce({ retryPort: repo });
    expect(repo.offers.get(offer.id)?.status).toBe("AGUARDANDO_ENVIO");

    await runDispatchWorkerOnce({ dispatchPort: repo, hyperflowService, redis });
    expect(repo.offers.get(offer.id)?.status).toBe("ENVIADO");
  });

  it("oferta travada em EM_PROCESSAMENTO_ENVIO é liberada pela reconciliação e completa o disparo", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.addEndpoint({
      id: "endpoint-c6-2",
      nome: "C6",
      url: "https://example.com/c6",
      metodoHttp: "POST",
      headers: null,
      authType: "NONE",
      credenciaisRef: null,
      capacidadeMinuto: null,
      capacidadeHora: 1000,
      capacidadeDia: null,
      timeoutMs: 5000,
      maxTentativas: 3,
      ativo: true,
    });
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      status: "EM_PROCESSAMENTO_ENVIO",
      endpointId: "endpoint-c6-2",
      reservedAt: new Date(Date.now() - 20 * 60 * 1000), // worker "morreu" há 20 min
    });

    await runReconciliationWorkerOnce({ reconciliationPort: repo, slaMs: 10 * 60 * 1000 });
    expect(repo.offers.get(offer.id)?.status).toBe("AGUARDANDO_ENVIO");

    await runDispatchWorkerOnce({
      dispatchPort: repo,
      hyperflowService: { dispatch: async () => ({ sucesso: true, httpStatus: 200, request: {}, respostaBruta: {} }) },
      redis,
    });
    expect(repo.offers.get(offer.id)?.status).toBe("ENVIADO");
  });
});
