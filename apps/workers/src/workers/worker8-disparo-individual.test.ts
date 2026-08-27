import { describe, expect, it } from "vitest";
import type { OfferSnapshot } from "@plataforma-ofertas/domain";
import {
  montarDisparoIndividualBody,
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

function endpoint(id: string, url: string, ativo = true): DisparoIndividualEndpoint {
  return { id, url, ativo };
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
      port: { claimOffersAguardandoDisparo: async () => { chamouClaim = true; return []; } },
    });
    expect(resultado).toBe(0);
    expect(chamouClaim).toBe(false);
  });

  it("não faz nada quando está ativo mas sem nenhum endpoint cadastrado", async () => {
    let chamouClaim = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [],
      port: { claimOffersAguardandoDisparo: async () => { chamouClaim = true; return []; } },
    });
    expect(resultado).toBe(0);
    expect(chamouClaim).toBe(false);
  });

  it("não faz nada quando todos os endpoints cadastrados estão desativados", async () => {
    let chamouClaim = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://exemplo.com/a", false), endpoint("e2", "https://exemplo.com/b", false)],
      port: { claimOffersAguardandoDisparo: async () => { chamouClaim = true; return []; } },
    });
    expect(resultado).toBe(0);
    expect(chamouClaim).toBe(false);
  });

  it("não chama a rede quando não tem nenhum lead esperando", async () => {
    let chamouFetch = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://exemplo.com/webhook")],
      port: { claimOffersAguardandoDisparo: async () => [] },
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
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake({ id: "offer-xyz" })] },
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
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake()] },
      fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });
    expect(resultado).toBe(0);
  });

  it("devolve 0 (sem crashar) quando o fetch lança uma exceção (timeout, DNS, etc.)", async () => {
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpoints: [endpoint("e1", "https://parceiro.com/nao-resolve")],
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake()] },
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
      },
      fetchImpl: (async (url) => { urlsChamadas.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch,
    });
    expect(resultado).toBe(1);
    expect(urlsChamadas).toEqual(["https://a.com"]); // só o primeiro recebeu
  });
});
