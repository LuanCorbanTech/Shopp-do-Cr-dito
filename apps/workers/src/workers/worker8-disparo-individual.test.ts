import { describe, expect, it } from "vitest";
import type { OfferSnapshot } from "@plataforma-ofertas/domain";
import {
  montarDisparoIndividualBody,
  montarDisparoIndividualBodyAraraHQ,
  runDisparoIndividualWorkerOnce,
  type DisparoIndividualEndpoint,
} from "./worker8-disparo-individual";

function ofertaFake(overrides: Partial<OfferSnapshot> = {}): OfferSnapshot {
  return {
    id: "offer-1",
    webhookId: "webhook-1",
    externalId: "ext-1",
    nome: "João Silva",
    cpf: "11111111111",
    dataNascimento: new Date("1990-02-03T00:00:00Z"),
    telefoneOriginal: "62999999999",
    telefoneAtualizado: "5562999999999",
    telefoneValidado: "5562999999999",
    possuiWhatsapp: true,
    bancoAutorizado: "C6",
    produto: "consignado",
    valor: 5000,
    parcelas: 12,
    status: "DISPARO_CONSULTADO",
    routingRuleId: null,
    endpointId: null,
    tentativasTelefone: 0,
    tentativasWhatsapp: 0,
    tentativasEnvio: 0,
    whatsappRequestId: null,
    whatsappLoteId: null,
    whatsappCheckIniciadoEm: null,
    ...overrides,
  };
}

function endpoint(
  id: string,
  url: string,
  ativo = true,
  modelo: "hyperflow" | "ararahq" = "hyperflow"
): DisparoIndividualEndpoint {
  return { id, url, ativo, modelo };
}

describe("montarDisparoIndividualBody", () => {
  it("monta o corpo com os mesmos campos do GET /aguardando-disparo", () => {
    const body = montarDisparoIndividualBody(ofertaFake());
    expect(body).toEqual({
      id: "offer-1",
      externalId: "ext-1",
      nome: "João Silva",
      cpf: "11111111111",
      dataNascimento: "1990-02-03T00:00:00.000Z",
      telefoneWhatsapp: "5562999999999",
      possuiWhatsapp: true,
      bancoAutorizado: "C6",
      produto: "consignado",
      valor: 5000,
      parcelas: 12,
    });
  });

  it("dataNascimento nula vira null, não quebra", () => {
    const body = montarDisparoIndividualBody(ofertaFake({ dataNascimento: null }));
    expect(body.dataNascimento).toBeNull();
  });
});

describe("runDisparoIndividualWorkerOnce", () => {
  it("não faz nada quando está desativado (nem chama a fila)", async () => {
    let chamouClaim = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: false,
      endpoints: [endpoint("e1", "https://exemplo.com/webhook")],
      port: { claimOffersAguardandoDisparo: async () => { chamouClaim = true; return []; },
        registrarTentativaDisparoIndividual: async () => {},
      },
    });
    expect(resultado).toBe(0);
    expect(chamouClaim).toBe(false);
  });

  it("não faz nada quando está ativo mas sem nenhum endpoint cadastrado", async () => {
    let chamouClaim = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [],
      port: { claimOffersAguardandoDisparo: async () => { chamouClaim = true; return []; },
        registrarTentativaDisparoIndividual: async () => {},
      },
    });
    expect(resultado).toBe(0);
    expect(chamouClaim).toBe(false);
  });

  it("não faz nada quando todos os endpoints cadastrados estão desativados", async () => {
    let chamouClaim = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://exemplo.com/a", false), endpoint("e2", "https://exemplo.com/b", false)],
      port: { claimOffersAguardandoDisparo: async () => { chamouClaim = true; return []; },
        registrarTentativaDisparoIndividual: async () => {},
      },
    });
    expect(resultado).toBe(0);
    expect(chamouClaim).toBe(false);
  });

  it("não chama a rede quando não tem nenhum lead esperando", async () => {
    let chamouFetch = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://exemplo.com/webhook")],
      port: { claimOffersAguardandoDisparo: async () => [],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async () => { chamouFetch = true; return new Response(null, { status: 200 }); }) as typeof fetch,
    });
    expect(resultado).toBe(0);
    expect(chamouFetch).toBe(false);
  });

  it("com 1 endpoint só, pede limit=1 (comportamento antigo preservado)", async () => {
    let limitPedido: number | null = null;
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://exemplo.com/webhook")],
      port: {
        claimOffersAguardandoDisparo: async (limit) => { limitPedido = limit; return [ofertaFake()]; },
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    expect(limitPedido).toBe(1);
  });

  it("manda exatamente 1 requisição POST com o corpo certo, pro endpoint configurado (1 endpoint só)", async () => {
    let urlChamada: string | null = null;
    let metodoChamado: string | null = null;
    let corpoChamado: string | null = null;
    let headersChamados: Record<string, string> | null = null;

    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://parceiro.com/receber-lead")],
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake({ id: "offer-xyz" })],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (url, init) => {
        urlChamada = String(url);
        metodoChamado = init?.method ?? null;
        corpoChamado = init?.body as string;
        headersChamados = init?.headers as Record<string, string>;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    expect(resultado).toBe(1);
    expect(urlChamada).toBe("https://parceiro.com/receber-lead");
    expect(metodoChamado).toBe("POST");
    expect(headersChamados).toEqual({ "Content-Type": "application/json" });
    const corpo = JSON.parse(corpoChamado as unknown as string);
    expect(corpo.id).toBe("offer-xyz");
  });

  it("devolve 0 (sem crashar) quando o endpoint responde com erro", async () => {
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://parceiro.com/fora-do-ar")],
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake()],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });
    expect(resultado).toBe(0);
  });

  it("devolve 0 (sem crashar) quando o fetch lança uma exceção (timeout, DNS, etc.)", async () => {
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://parceiro.com/nao-resolve")],
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake()],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
    });
    expect(resultado).toBe(0);
  });

  // ---- Cenários novos: múltiplos endpoints ----

  it("com 3 endpoints ativos, pede limit=3 (1 lead pra cada)", async () => {
    let limitPedido: number | null = null;
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://a.com"), endpoint("e2", "https://b.com"), endpoint("e3", "https://c.com")],
      port: {
        claimOffersAguardandoDisparo: async (limit) => {
          limitPedido = limit;
          return [ofertaFake({ id: "o1" }), ofertaFake({ id: "o2" }), ofertaFake({ id: "o3" })];
        },
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    expect(limitPedido).toBe(3);
  });

  it("manda 1 lead DIFERENTE pra CADA endpoint, ao mesmo tempo (não em sequência)", async () => {
    const chamadasPorUrl: Record<string, string> = {};
    const ordemDeInicio: string[] = [];
    const ordemDeTermino: string[] = [];

    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://a.com"), endpoint("e2", "https://b.com"), endpoint("e3", "https://c.com")],
      port: {
        claimOffersAguardandoDisparo: async () => [
          ofertaFake({ id: "offer-A" }),
          ofertaFake({ id: "offer-B" }),
          ofertaFake({ id: "offer-C" }),
        ],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (url, init) => {
        const urlStr = String(url);
        ordemDeInicio.push(urlStr);
        const corpo = JSON.parse(init?.body as string);
        chamadasPorUrl[urlStr] = corpo.id;
        // Simula latências DIFERENTES por endpoint — se fosse sequencial
        // (não paralelo), a ordem de término bateria com a ordem de início;
        // em paralelo, o mais rápido (c.com) termina primeiro mesmo tendo
        // começado por último.
        const atrasoMs = urlStr === "https://a.com" ? 30 : urlStr === "https://b.com" ? 20 : 5;
        await new Promise((r) => setTimeout(r, atrasoMs));
        ordemDeTermino.push(urlStr);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    expect(resultado).toBe(3);
    // Cada endpoint recebeu um lead DIFERENTE (não o mesmo repetido 3x)
    expect(new Set(Object.values(chamadasPorUrl)).size).toBe(3);
    expect(chamadasPorUrl["https://a.com"]).toBe("offer-A");
    expect(chamadasPorUrl["https://b.com"]).toBe("offer-B");
    expect(chamadasPorUrl["https://c.com"]).toBe("offer-C");
    // Prova que rodou em PARALELO: o que tinha o menor atraso (c.com)
    // terminou primeiro, mesmo tendo sido chamado por último.
    expect(ordemDeInicio).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
    expect(ordemDeTermino[0]).toBe("https://c.com");
  });

  it("endpoint DESATIVADO não recebe nada, mesmo estando na lista — só os ativos contam", async () => {
    let limitPedido: number | null = null;
    const urlsChamadas: string[] = [];

    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [
        endpoint("e1", "https://ativo1.com", true),
        endpoint("e2", "https://desativado.com", false),
        endpoint("e3", "https://ativo2.com", true),
      ],
      port: {
        claimOffersAguardandoDisparo: async (limit) => {
          limitPedido = limit;
          return [ofertaFake({ id: "o1" }), ofertaFake({ id: "o2" })];
        },
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (url) => { urlsChamadas.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch,
    });

    expect(limitPedido).toBe(2); // só os 2 ativos contam, não os 3 cadastrados
    expect(urlsChamadas).toEqual(["https://ativo1.com", "https://ativo2.com"]);
    expect(urlsChamadas).not.toContain("https://desativado.com");
    expect(resultado).toBe(2);
  });

  it("se 1 endpoint falhar, os outros continuam funcionando normalmente (falha isolada)", async () => {
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://bom1.com"), endpoint("e2", "https://ruim.com"), endpoint("e3", "https://bom2.com")],
      port: {
        claimOffersAguardandoDisparo: async () => [
          ofertaFake({ id: "o1" }), ofertaFake({ id: "o2" }), ofertaFake({ id: "o3" }),
        ],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (url) => {
        if (String(url) === "https://ruim.com") throw new Error("ECONNREFUSED");
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    // 2 dos 3 tiveram sucesso — a falha de 1 não derrubou os outros.
    expect(resultado).toBe(2);
  });

  it("menos leads esperando do que endpoints ativos — manda só pros primeiros, sem erro", async () => {
    const urlsChamadas: string[] = [];
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://a.com"), endpoint("e2", "https://b.com"), endpoint("e3", "https://c.com")],
      port: {
        // Só 1 lead disponível, mesmo com 3 endpoints ativos pedindo limit=3
        claimOffersAguardandoDisparo: async () => [ofertaFake({ id: "unico" })],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (url) => { urlsChamadas.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch,
    });
    expect(resultado).toBe(1);
    expect(urlsChamadas).toEqual(["https://a.com"]); // só o primeiro recebeu
  });

  it("endpoint que TRAVA (nunca responde) não prende o ciclo pra sempre — timeout isola só ele, os outros terminam normalmente", async () => {
    const inicioTeste = Date.now();
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://bom1.com"), endpoint("e2", "https://trava-pra-sempre.com"), endpoint("e3", "https://bom2.com")],
      timeoutMsPorEndpoint: 200, // curto só pro teste não demorar — produção usa 10s
      port: {
        claimOffersAguardandoDisparo: async () => [
          ofertaFake({ id: "o1" }), ofertaFake({ id: "o2" }), ofertaFake({ id: "o3" }),
        ],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (url, init) => {
        if (String(url) === "https://trava-pra-sempre.com") {
          // Simula um endpoint que NUNCA responde nem dá erro — só o abort
          // (via signal) consegue destravar essa promise. Sem o timeout no
          // worker, isso prenderia o Promise.allSettled pra sempre.
          return new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    const duracaoMs = Date.now() - inicioTeste;

    // 2 dos 3 tiveram sucesso (o travado conta como falha, mas não impede os outros).
    expect(resultado).toBe(2);
    // O ciclo TERMINOU por causa do timeout (200ms configurado), não ficou
    // pendurado pra sempre — com uma folga generosa pra não ficar flaky.
    expect(duracaoMs).toBeLessThan(2000);
  });
});

describe("montarDisparoIndividualBodyAraraHQ", () => {
  it("BUG REAL corrigido em 04/09: adiciona o DDI (55) quando telefoneValidado não tem — esse é o formato NORMAL (telefoneValidado normalmente vem sem DDI, mesmo formato usado pra Hyperflow). Antes da correção, isso virava um número da Dinamarca (+45...) em vez do Brasil.", () => {
    const body = montarDisparoIndividualBodyAraraHQ(ofertaFake({ telefoneValidado: "45999701663", nome: "Cliente Real" }));
    expect(body).toEqual({ phone: "+5545999701663", name: "Cliente Real" });
  });

  it("monta o corpo simples da Ararahq — só phone (com + e DDI) e name", () => {
    const body = montarDisparoIndividualBodyAraraHQ(ofertaFake({ telefoneValidado: "83991768778", nome: "Micael" }));
    expect(body).toEqual({ phone: "+5583991768778", name: "Micael" });
  });

  it("não duplica o 55 se telefoneValidado já vier com o DDI incluso", () => {
    const body = montarDisparoIndividualBodyAraraHQ(ofertaFake({ telefoneValidado: "5583991768778" }));
    expect(body.phone).toBe("+5583991768778");
  });

  it("não duplica o + se telefoneValidado já vier com ele por algum motivo", () => {
    const body = montarDisparoIndividualBodyAraraHQ(ofertaFake({ telefoneValidado: "+5583991768778" }));
    expect(body.phone).toBe("+5583991768778");
  });

  it("telefone nulo vira null, não quebra", () => {
    const body = montarDisparoIndividualBodyAraraHQ(ofertaFake({ telefoneValidado: null }));
    expect(body.phone).toBeNull();
  });
});

describe("runDisparoIndividualWorkerOnce — modelo Ararahq", () => {
  it("manda o corpo no formato da Ararahq (não o da Hyperflow) pra um endpoint desse modelo", async () => {
    let corpoRecebido: unknown = null;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://api.ararahq.com/v1/messages/webhook", true, "ararahq")],
      ararahqApiKey: "ara_live_segredo123",
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake({ telefoneValidado: "5583991768778", nome: "Micael" })],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (_url, init) => {
        corpoRecebido = JSON.parse(init?.body as string);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(resultado).toBe(1);
    expect(corpoRecebido).toEqual({ phone: "+5583991768778", name: "Micael" });
  });

  it("manda os cabeçalhos certos da Ararahq: Authorization Bearer (chave compartilhada) + Idempotency-Key", async () => {
    let headersRecebidos: Record<string, string> | null = null;
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://api.ararahq.com/v1/messages/webhook", true, "ararahq")],
      ararahqApiKey: "ara_live_segredo123",
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake()],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (_url, init) => {
        headersRecebidos = init?.headers as Record<string, string>;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(headersRecebidos).not.toBeNull();
    expect(headersRecebidos!["Authorization"]).toBe("Bearer ara_live_segredo123");
    expect(headersRecebidos!["Content-Type"]).toBe("application/json");
    expect(headersRecebidos!["Idempotency-Key"]).toBeTruthy();
  });

  it("gera um Idempotency-Key DIFERENTE a cada envio (nunca repete) — confirmado com o dev da Ararahq como requisito", async () => {
    const chavesUsadas: string[] = [];
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [
        endpoint("e1", "https://api.ararahq.com/a", true, "ararahq"),
        endpoint("e2", "https://api.ararahq.com/b", true, "ararahq"),
        endpoint("e3", "https://api.ararahq.com/c", true, "ararahq"),
      ],
      ararahqApiKey: "ara_live_segredo123",
      port: {
        claimOffersAguardandoDisparo: async () => [ofertaFake({ id: "o1" }), ofertaFake({ id: "o2" }), ofertaFake({ id: "o3" })],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        chavesUsadas.push(headers["Idempotency-Key"]);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(chavesUsadas.length).toBe(3);
    expect(new Set(chavesUsadas).size).toBe(3); // as 3 são diferentes entre si
  });

  it("com o gerador de verdade (produção), o Idempotency-Key é um UUID válido", async () => {
    let chaveRecebida = "";
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://api.ararahq.com/webhook", true, "ararahq")],
      ararahqApiKey: "ara_live_segredo123",
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake()],
        registrarTentativaDisparoIndividual: async () => {},
      },
      // Sem "gerarIdempotencyKey" customizado — usa o de produção (randomUUID de verdade).
      fetchImpl: (async (_url, init) => {
        chaveRecebida = (init?.headers as Record<string, string>)["Idempotency-Key"];
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(chaveRecebida).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("endpoint Hyperflow e endpoint Ararahq no MESMO ciclo — cada um recebe o formato certo, sem misturar", async () => {
    const corposRecebidos: Record<string, unknown> = {};
    const headersRecebidos: Record<string, Record<string, string>> = {};
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [
        endpoint("e1", "https://hyperflow.com/fluxo1", true, "hyperflow"),
        endpoint("e2", "https://api.ararahq.com/webhook", true, "ararahq"),
      ],
      ararahqApiKey: "ara_live_segredo123",
      port: {
        claimOffersAguardandoDisparo: async () => [
          ofertaFake({ id: "lead-hyperflow", nome: "Cliente Hyperflow", telefoneValidado: "5562999999999" }),
          ofertaFake({ id: "lead-ararahq", nome: "Cliente Ararahq", telefoneValidado: "5583991768778" }),
        ],
        registrarTentativaDisparoIndividual: async () => {},
      },
      fetchImpl: (async (url, init) => {
        const urlStr = String(url);
        corposRecebidos[urlStr] = JSON.parse(init?.body as string);
        headersRecebidos[urlStr] = init?.headers as Record<string, string>;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    expect(resultado).toBe(2);
    // Endpoint Hyperflow recebeu o formato completo (id, cpf, banco, etc.), sem Authorization.
    const corpoHyperflow = corposRecebidos["https://hyperflow.com/fluxo1"] as Record<string, unknown>;
    expect(corpoHyperflow.id).toBe("lead-hyperflow");
    expect(corpoHyperflow.telefoneWhatsapp).toBe("5562999999999");
    expect(headersRecebidos["https://hyperflow.com/fluxo1"]["Authorization"]).toBeUndefined();

    // Endpoint Ararahq recebeu o formato simples (phone com +, name), com Authorization.
    const corpoArarahq = corposRecebidos["https://api.ararahq.com/webhook"] as Record<string, unknown>;
    expect(corpoArarahq).toEqual({ phone: "+5583991768778", name: "Cliente Ararahq" });
    expect(headersRecebidos["https://api.ararahq.com/webhook"]["Authorization"]).toBe("Bearer ara_live_segredo123");
  });
});

describe("runDisparoIndividualWorkerOnce — registro da tentativa (pra aparecer na tela da oferta)", () => {
  it("registra uma tentativa de SUCESSO com os dados certos", async () => {
    const registradas: unknown[] = [];
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://hyperflow.com/fluxo1", true, "hyperflow")],
      port: {
        claimOffersAguardandoDisparo: async () => [ofertaFake({ id: "offer-xyz" })],
        registrarTentativaDisparoIndividual: async (dados) => { registradas.push(dados); },
      },
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    expect(registradas).toEqual([
      {
        offerId: "offer-xyz",
        endpointId: "e1",
        endpointUrl: "https://hyperflow.com/fluxo1",
        modelo: "hyperflow",
        sucesso: true,
        httpStatus: 200,
        timeout: false,
        erro: null,
        payloadEnviado: expect.objectContaining({ id: "offer-xyz" }),
      },
    ]);
  });

  it("registra uma tentativa de FALHA (endpoint respondeu com erro) com o status HTTP certo", async () => {
    const registradas: unknown[] = [];
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://parceiro.com/fora-do-ar", true, "hyperflow")],
      port: {
        claimOffersAguardandoDisparo: async () => [ofertaFake({ id: "offer-xyz" })],
        registrarTentativaDisparoIndividual: async (dados) => { registradas.push(dados); },
      },
      fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });
    expect(registradas).toEqual([
      {
        offerId: "offer-xyz",
        endpointId: "e1",
        endpointUrl: "https://parceiro.com/fora-do-ar",
        modelo: "hyperflow",
        sucesso: false,
        httpStatus: 500,
        timeout: false,
        erro: null,
        payloadEnviado: expect.objectContaining({ id: "offer-xyz" }),
      },
    ]);
  });

  it("BUG REAL corrigido em 03/09: guarda o payload EXATO enviado (igual ao que a tela mostra em 'Ver payload enviado') — testa os 2 modelos", async () => {
    const registradas: Array<{ modelo: string; payloadEnviado: unknown }> = [];
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [
        endpoint("e1", "https://hyperflow.com/fluxo1", true, "hyperflow"),
        endpoint("e2", "https://api.ararahq.com/webhook", true, "ararahq"),
      ],
      ararahqApiKey: "ara_live_x",
      port: {
        claimOffersAguardandoDisparo: async () => [
          ofertaFake({ id: "lead-hf", nome: "Cliente Hyperflow", telefoneValidado: "5562999999999" }),
          ofertaFake({ id: "lead-ara", nome: "Cliente Ararahq", telefoneValidado: "5583991768778" }),
        ],
        registrarTentativaDisparoIndividual: async (dados) => { registradas.push(dados); },
      },
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });

    const hf = registradas.find((r) => r.modelo === "hyperflow");
    const ara = registradas.find((r) => r.modelo === "ararahq");
    // O payload salvo é o MESMO objeto (mesmo formato) que de fato foi mandado.
    expect(hf?.payloadEnviado).toMatchObject({ id: "lead-hf", nome: "Cliente Hyperflow", telefoneWhatsapp: "5562999999999" });
    expect(ara?.payloadEnviado).toEqual({ phone: "+5583991768778", name: "Cliente Ararahq" });
  });

  it("registra uma tentativa de FALHA por TIMEOUT com timeout=true e a mensagem de erro", async () => {
    const registradas: any[] = [];
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://trava.com", true, "hyperflow")],
      timeoutMsPorEndpoint: 100,
      port: {
        claimOffersAguardandoDisparo: async () => [ofertaFake({ id: "offer-xyz" })],
        registrarTentativaDisparoIndividual: async (dados) => { registradas.push(dados); },
      },
      fetchImpl: (async (_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as typeof fetch,
    });
    expect(registradas).toHaveLength(1);
    expect(registradas[0].sucesso).toBe(false);
    expect(registradas[0].timeout).toBe(true);
    expect(registradas[0].httpStatus).toBeNull();
    expect(registradas[0].erro).toBeTruthy();
  });

  it("uma FALHA ao gravar a tentativa (banco fora do ar) não afeta o resultado do envio em si", async () => {
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://hyperflow.com/fluxo1", true, "hyperflow")],
      port: {
        claimOffersAguardandoDisparo: async () => [ofertaFake()],
        registrarTentativaDisparoIndividual: async () => { throw new Error("banco fora do ar"); },
      },
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    // O envio em si continua contando como sucesso, mesmo a gravação do
    // registro tendo falhado — são coisas independentes.
    expect(resultado).toBe(1);
  });

  it("com vários endpoints, registra uma tentativa PRA CADA um", async () => {
    const registradas: unknown[] = [];
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [
        endpoint("e1", "https://a.com", true, "hyperflow"),
        endpoint("e2", "https://api.ararahq.com/webhook", true, "ararahq"),
      ],
      ararahqApiKey: "ara_live_x",
      port: {
        claimOffersAguardandoDisparo: async () => [ofertaFake({ id: "o1" }), ofertaFake({ id: "o2" })],
        registrarTentativaDisparoIndividual: async (dados) => { registradas.push(dados); },
      },
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    expect(registradas).toHaveLength(2);
  });
});
