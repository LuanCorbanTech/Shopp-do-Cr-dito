import { describe, expect, it } from "vitest";
import type { OfferSnapshot } from "@plataforma-ofertas/domain";
import { montarDisparoIndividualBody, runDisparoIndividualWorkerOnce } from "./worker8-disparo-individual";

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
      endpointUrl: "https://exemplo.com/webhook",
      port: { claimOffersAguardandoDisparo: async () => { chamouClaim = true; return []; } },
    });
    expect(resultado).toBe(0);
    expect(chamouClaim).toBe(false);
  });

  it("não faz nada quando está ativo mas sem endpoint cadastrado", async () => {
    let chamouClaim = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpointUrl: null,
      port: { claimOffersAguardandoDisparo: async () => { chamouClaim = true; return []; } },
    });
    expect(resultado).toBe(0);
    expect(chamouClaim).toBe(false);
  });

  it("não chama a rede quando não tem nenhum lead esperando", async () => {
    let chamouFetch = false;
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpointUrl: "https://exemplo.com/webhook",
      port: { claimOffersAguardandoDisparo: async () => [] },
      fetchImpl: (async () => { chamouFetch = true; return new Response(null, { status: 200 }); }) as typeof fetch,
    });
    expect(resultado).toBe(0);
    expect(chamouFetch).toBe(false);
  });

  it("pede só 1 lead por vez (limit=1), mesmo que a fila tenha mais gente esperando", async () => {
    let limitPedido: number | null = null;
    await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpointUrl: "https://exemplo.com/webhook",
      port: {
        claimOffersAguardandoDisparo: async (limit) => { limitPedido = limit; return [ofertaFake()]; },
      },
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    expect(limitPedido).toBe(1);
  });

  it("manda exatamente 1 requisição POST com o corpo certo, pro endpoint configurado", async () => {
    let urlChamada: string | null = null;
    let metodoChamado: string | null = null;
    let corpoChamado: string | null = null;
    let headersChamados: Record<string, string> | null = null;

    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpointUrl: "https://parceiro.com/receber-lead",
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
      endpointUrl: "https://parceiro.com/fora-do-ar",
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake()] },
      fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });
    expect(resultado).toBe(0);
  });

  it("devolve 0 (sem crashar) quando o fetch lança uma exceção (timeout, DNS, etc.)", async () => {
    const resultado = await runDisparoIndividualWorkerOnce({
      ativo: true,
      endpointUrl: "https://parceiro.com/nao-resolve",
      port: { claimOffersAguardandoDisparo: async () => [ofertaFake()] },
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
    });
    expect(resultado).toBe(0);
  });
});
