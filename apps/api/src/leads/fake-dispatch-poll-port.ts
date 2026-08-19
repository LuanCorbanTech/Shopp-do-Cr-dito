import type { DispatchPollPort, OfferSnapshot } from "@plataforma-ofertas/domain";

export function fakeOferta(overrides: Partial<OfferSnapshot> = {}): OfferSnapshot {
  return {
    id: "offer-1",
    webhookId: "webhook-1",
    externalId: "lead-externo-1",
    nome: "Lucas Mendes",
    cpf: "03073732152",
    dataNascimento: new Date("1990-02-03T02:00:00.000Z"),
    telefoneOriginal: "62993718537",
    telefoneAtualizado: "5562993718537",
    telefoneValidado: "5562993718537",
    possuiWhatsapp: true,
    bancoAutorizado: "C6",
    produto: "credito-pessoal",
    valor: 5000,
    parcelas: 12,
    status: "AGUARDANDO_DISPARO",
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

export class FakeDispatchPollPort implements DispatchPollPort {
  ofertasDisponiveis: OfferSnapshot[] = [];
  ultimoLimitPedido: number | null = null;
  // chave: id ou externalId usado na chamada -> a oferta "existente" nesse fake
  ofertasPorChave: Map<string, OfferSnapshot> = new Map();

  async claimOffersAguardandoDisparo(limit: number): Promise<OfferSnapshot[]> {
    this.ultimoLimitPedido = limit;
    const consumidas = this.ofertasDisponiveis.slice(0, limit);
    // simula o consumo atômico: uma vez lida, não aparece mais.
    this.ofertasDisponiveis = this.ofertasDisponiveis.slice(limit);
    return consumidas;
  }

  async atualizarStatusDisparo(params: {
    id?: string;
    externalId?: string;
    novoStatus: "DISPARO_ENVIADO" | "DISPARO_RESPONDIDO";
  }): Promise<OfferSnapshot | null> {
    const chave = params.id ?? params.externalId;
    if (!chave) return null;
    const encontrada = this.ofertasPorChave.get(chave) ?? [...this.ofertasPorChave.values()].find((o) => o.id === chave || o.externalId === chave);
    if (!encontrada) return null;
    const atualizada = { ...encontrada, status: params.novoStatus };
    this.ofertasPorChave.set(chave, atualizada);
    return atualizada;
  }
}
