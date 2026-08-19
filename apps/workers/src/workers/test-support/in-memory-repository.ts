import type {
  IntegrationConfigPort,
  IntegrationConfigSnapshot,
  PhoneProcessingPort,
  WhatsappValidationPort,
  RoutingPort,
  RoutingRuleSnapshot,
  DispatchPort,
  EndpointSnapshot,
  RetryPort,
  ReconciliationPort,
  StuckOfferSnapshot,
  OfferSnapshot,
  InfoPessoaLemit,
} from "@plataforma-ofertas/domain";

// Réplica em memória de todas as portas dos workers 1-6, no mesmo espírito do
// fake-offers-port.ts da Fase 1 — permite testar a orquestração de cada worker (e a
// cadeia completa RECEBIDO -> ENVIADO) sem Postgres/Redis reais.

export interface MutableOffer extends OfferSnapshot {
  reservedAt: Date | null;
  proximaTentativaEm: Date | null;
  createdAt: Date;
  // Não fazem parte de OfferSnapshot (Worker 1 só escreve, nenhum worker precisa
  // ler de volta) — ficam aqui só pra dar visibilidade nos testes.
  dadosPessoaLemit?: Record<string, unknown> | null;
  possuiWhatsappSegundoLemit?: boolean | null;
  // "Retrato" da Lemit (ver extrairInfoPessoaLemit) — igual acima, só pra
  // visibilidade em teste; dataNascimento já está em OfferSnapshot.
  sexo?: string | null;
  nomeMae?: string | null;
  email?: string | null;
  telefoneLemit?: string | null;
  whatsappLemit?: boolean | null;
  endereco?: string | null;
  uf?: string | null;
  cep?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  numero?: string | null;
  logradouro?: string | null;
  complemento?: string | null;
}

const IN_FLIGHT_STATUSES = [
  "PROCESSANDO_TELEFONE",
  "VALIDANDO_WHATSAPP",
  "EM_PROCESSAMENTO_ENVIO",
  "AGUARDANDO_ROTEAMENTO",
  "SEM_ROTA_CONFIGURADA",
];

const ERROR_STATUSES = ["ERRO_TELEFONE", "ERRO_VALIDACAO_WHATSAPP", "ERRO_ENVIO"];

export class InMemoryPipelineRepository
  implements
    IntegrationConfigPort,
    PhoneProcessingPort,
    WhatsappValidationPort,
    RoutingPort,
    DispatchPort,
    RetryPort,
    ReconciliationPort
{
  readonly offers = new Map<string, MutableOffer>();
  readonly configs = new Map<string, IntegrationConfigSnapshot>();
  readonly rules: RoutingRuleSnapshot[] = [];
  readonly endpoints = new Map<string, EndpointSnapshot>();
  readonly processingLog: Array<{ offerId: string; etapa: string; resultado: string; respostaBruta?: unknown }> = [];
  private idCounter = 0;

  addOffer(partial: Partial<MutableOffer> & { telefoneOriginal: string | null }): MutableOffer {
    this.idCounter += 1;
    const offer: MutableOffer = {
      id: partial.id ?? `offer-${this.idCounter}`,
      webhookId: partial.webhookId ?? "webhook-1",
      externalId: partial.externalId ?? null,
      nome: partial.nome ?? null,
      cpf: partial.cpf ?? null,
      dataNascimento: partial.dataNascimento ?? null,
      telefoneOriginal: partial.telefoneOriginal,
      telefoneAtualizado: partial.telefoneAtualizado ?? null,
      telefoneValidado: partial.telefoneValidado ?? null,
      possuiWhatsapp: partial.possuiWhatsapp ?? null,
      bancoAutorizado: partial.bancoAutorizado ?? null,
      produto: partial.produto ?? null,
      valor: partial.valor ?? null,
      parcelas: partial.parcelas ?? null,
      status: partial.status ?? "RECEBIDO",
      routingRuleId: partial.routingRuleId ?? null,
      endpointId: partial.endpointId ?? null,
      tentativasTelefone: partial.tentativasTelefone ?? 0,
      tentativasWhatsapp: partial.tentativasWhatsapp ?? 0,
      tentativasEnvio: partial.tentativasEnvio ?? 0,
      whatsappRequestId: partial.whatsappRequestId ?? null,
      whatsappCheckIniciadoEm: partial.whatsappCheckIniciadoEm ?? null,
      dadosPessoaLemit: partial.dadosPessoaLemit ?? null,
      possuiWhatsappSegundoLemit: partial.possuiWhatsappSegundoLemit ?? null,
      reservedAt: partial.reservedAt ?? null,
      proximaTentativaEm: partial.proximaTentativaEm ?? null,
      createdAt: partial.createdAt ?? new Date(Date.now() + this.idCounter), // preserva ordem de inserção
    };
    this.offers.set(offer.id, offer);
    return offer;
  }

  setConfig(chave: string, ativo: boolean, valor: Record<string, unknown> = {}): void {
    this.configs.set(chave, { chave, ativo, valor });
  }

  addEndpoint(endpoint: EndpointSnapshot): void {
    this.endpoints.set(endpoint.id, endpoint);
  }

  addRule(rule: RoutingRuleSnapshot): void {
    this.rules.push(rule);
  }

  private require(offerId: string): MutableOffer {
    const offer = this.offers.get(offerId);
    if (!offer) throw new Error(`fake repository: oferta não encontrada: ${offerId}`);
    return offer;
  }

  private snapshot(offer: MutableOffer): OfferSnapshot {
    const { reservedAt, proximaTentativaEm, createdAt, ...rest } = offer;
    return { ...rest };
  }

  private claimByStatus(fromStatuses: string[], toStatus: string, limit: number): OfferSnapshot[] {
    const candidates = [...this.offers.values()]
      .filter((o) => fromStatuses.includes(o.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    for (const o of candidates) {
      o.status = toStatus;
      o.reservedAt = new Date();
    }
    return candidates.map((o) => this.snapshot(o));
  }

  // ---------------------------------------------------------------------------
  // IntegrationConfigPort
  // ---------------------------------------------------------------------------
  async getConfig(chave: string): Promise<IntegrationConfigSnapshot | null> {
    return this.configs.get(chave) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Worker 1 — PhoneProcessingPort
  // ---------------------------------------------------------------------------
  async claimOffersReceived(limit: number): Promise<OfferSnapshot[]> {
    return this.claimByStatus(["RECEBIDO"], "PROCESSANDO_TELEFONE", limit);
  }

  async markPhoneSkippedLimitDisabled(offerId: string): Promise<void> {
    const offer = this.require(offerId);
    offer.status = "TELEFONE_ATUALIZADO";
    offer.reservedAt = null;
    this.processingLog.push({ offerId, etapa: "LIMIT", resultado: "IGNORADO" });
  }

  async markPhoneSkippedSemDocumento(offerId: string): Promise<void> {
    const offer = this.require(offerId);
    offer.status = "TELEFONE_ATUALIZADO";
    offer.reservedAt = null;
    this.processingLog.push({ offerId, etapa: "LIMIT", resultado: "SEM_DOCUMENTO" });
  }

  async markPhoneUpdated(
    offerId: string,
    params: {
      telefoneAtualizado: string | null;
      dadosPessoa?: Record<string, unknown> | null;
      infoPessoa?: InfoPessoaLemit;
      possuiWhatsappSegundoLemit?: boolean | null;
    }
  ): Promise<void> {
    const offer = this.require(offerId);
    offer.status = "TELEFONE_ATUALIZADO";
    offer.telefoneAtualizado = params.telefoneAtualizado;
    offer.dadosPessoaLemit = params.dadosPessoa ?? null;
    offer.possuiWhatsappSegundoLemit = params.possuiWhatsappSegundoLemit ?? null;
    const info = params.infoPessoa;
    // "nome" só é sobrescrito quando a Lemit devolve um valor de verdade —
    // mesma regra do Prisma (mantém o nome existente se vier null).
    if (info?.nome) offer.nome = info.nome;
    offer.dataNascimento = info?.dataNascimento ?? null;
    offer.sexo = info?.sexo ?? null;
    offer.nomeMae = info?.nomeMae ?? null;
    offer.email = info?.email ?? null;
    offer.telefoneLemit = info?.telefone ?? null;
    offer.whatsappLemit = info?.whatsapp ?? null;
    offer.endereco = info?.endereco ?? null;
    offer.uf = info?.uf ?? null;
    offer.cep = info?.cep ?? null;
    offer.bairro = info?.bairro ?? null;
    offer.cidade = info?.cidade ?? null;
    offer.numero = info?.numero ?? null;
    offer.logradouro = info?.logradouro ?? null;
    offer.complemento = info?.complemento ?? null;
    offer.reservedAt = null;
    this.processingLog.push({ offerId, etapa: "LIMIT", resultado: "SUCESSO" });
  }

  async markPhoneFailed(
    offerId: string,
    params: { proximaTentativaEm: Date | null; cancelar: boolean; respostaBruta?: unknown }
  ): Promise<void> {
    const offer = this.require(offerId);
    offer.status = params.cancelar ? "CANCELADO" : "ERRO_TELEFONE";
    offer.reservedAt = null;
    offer.tentativasTelefone += 1;
    offer.proximaTentativaEm = params.proximaTentativaEm;
    this.processingLog.push({ offerId, etapa: "LIMIT", resultado: "FALHA", respostaBruta: params.respostaBruta });
  }

  async markPhoneCpfInvalido(offerId: string, respostaBruta?: unknown): Promise<void> {
    const offer = this.require(offerId);
    offer.status = "CPF_INVALIDO";
    offer.reservedAt = null;
    offer.tentativasTelefone += 1;
    offer.proximaTentativaEm = null;
    this.processingLog.push({ offerId, etapa: "LIMIT", resultado: "CPF_INVALIDO", respostaBruta });
  }

  // ---------------------------------------------------------------------------
  // Worker 2 — WhatsappValidationPort
  // ---------------------------------------------------------------------------
  async claimOffersForValidation(limit: number): Promise<OfferSnapshot[]> {
    return this.claimByStatus(["TELEFONE_ATUALIZADO"], "VALIDANDO_WHATSAPP", limit);
  }

  async markWhatsappCheckStarted(
    offerId: string,
    params: { requestId: string; telefoneUsado: string }
  ): Promise<void> {
    const offer = this.require(offerId);
    offer.whatsappRequestId = params.requestId;
    offer.whatsappCheckIniciadoEm = new Date();
    offer.reservedAt = null;
    this.processingLog.push({ offerId, etapa: "WHATSAPP", resultado: "CONSULTA_INICIADA" });
  }

  async findOfferByWhatsappRequestId(requestId: string): Promise<OfferSnapshot | null> {
    const offer = [...this.offers.values()].find((o) => o.whatsappRequestId === requestId);
    return offer ? this.snapshot(offer) : null;
  }

  async findOffersAwaitingWhatsappResult(params: {
    olderThanMs: number;
    limit: number;
    now?: Date;
  }): Promise<OfferSnapshot[]> {
    const now = params.now ?? new Date();
    const cutoff = now.getTime() - params.olderThanMs;
    const candidates = [...this.offers.values()]
      .filter(
        (o) =>
          o.status === "VALIDANDO_WHATSAPP" &&
          o.whatsappRequestId !== null &&
          o.whatsappCheckIniciadoEm !== null &&
          o.whatsappCheckIniciadoEm.getTime() < cutoff
      )
      .sort((a, b) => (a.whatsappCheckIniciadoEm?.getTime() ?? 0) - (b.whatsappCheckIniciadoEm?.getTime() ?? 0))
      .slice(0, params.limit);
    return candidates.map((o) => this.snapshot(o));
  }

  async markWhatsappValidated(
    offerId: string,
    params: { possuiWhatsapp: boolean; telefoneUsado: string }
  ): Promise<void> {
    const offer = this.require(offerId);
    // Novo modelo (17/08): sucesso vai direto pra AGUARDANDO_DISPARO, não mais
    // AGUARDANDO_ROTEAMENTO — não existe mais motor de roteamento interno.
    offer.status = params.possuiWhatsapp ? "AGUARDANDO_DISPARO" : "SEM_WHATSAPP";
    offer.telefoneValidado = params.possuiWhatsapp ? params.telefoneUsado : null;
    offer.possuiWhatsapp = params.possuiWhatsapp;
    offer.whatsappRequestId = null;
    offer.whatsappCheckIniciadoEm = null;
    offer.reservedAt = null;
    this.processingLog.push({
      offerId,
      etapa: "WHATSAPP",
      resultado: params.possuiWhatsapp ? "SUCESSO" : "SEM_WHATSAPP",
    });
  }

  async markWhatsappFailed(
    offerId: string,
    params: { proximaTentativaEm: Date | null; cancelar: boolean }
  ): Promise<void> {
    const offer = this.require(offerId);
    offer.status = params.cancelar ? "CANCELADO" : "ERRO_VALIDACAO_WHATSAPP";
    offer.whatsappRequestId = null;
    offer.whatsappCheckIniciadoEm = null;
    offer.reservedAt = null;
    offer.tentativasWhatsapp += 1;
    offer.proximaTentativaEm = params.proximaTentativaEm;
    this.processingLog.push({ offerId, etapa: "WHATSAPP", resultado: "FALHA" });
  }

  // ---------------------------------------------------------------------------
  // Worker 3 — RoutingPort
  // ---------------------------------------------------------------------------
  async claimOffersForRouting(limit: number): Promise<OfferSnapshot[]> {
    const candidates = [...this.offers.values()]
      .filter((o) => (o.status === "AGUARDANDO_ROTEAMENTO" || o.status === "SEM_ROTA_CONFIGURADA") && o.reservedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    for (const o of candidates) {
      o.reservedAt = new Date();
    }
    return candidates.map((o) => this.snapshot(o));
  }

  async listActiveRoutingRulesSortedByPriority(): Promise<RoutingRuleSnapshot[]> {
    return [...this.rules].sort((a, b) => a.prioridade - b.prioridade);
  }

  async isEndpointActive(endpointId: string): Promise<boolean> {
    return Boolean(this.endpoints.get(endpointId)?.ativo);
  }

  async assignRoute(offerId: string, params: { routingRuleId: string; endpointId: string }): Promise<void> {
    const offer = this.require(offerId);
    offer.status = "AGUARDANDO_ENVIO";
    offer.routingRuleId = params.routingRuleId;
    offer.endpointId = params.endpointId;
    offer.reservedAt = null;
    this.processingLog.push({ offerId, etapa: "ROTEAMENTO", resultado: "SUCESSO" });
  }

  async markNoRoute(offerId: string): Promise<void> {
    const offer = this.require(offerId);
    offer.status = "SEM_ROTA_CONFIGURADA";
    offer.reservedAt = null;
    this.processingLog.push({ offerId, etapa: "ROTEAMENTO", resultado: "SEM_ROTA" });
  }

  // ---------------------------------------------------------------------------
  // Worker 4 — DispatchPort
  // ---------------------------------------------------------------------------
  async listActiveEndpoints(): Promise<EndpointSnapshot[]> {
    return [...this.endpoints.values()].filter((e) => e.ativo);
  }

  async claimOffersForDispatch(endpointId: string, limit: number): Promise<OfferSnapshot[]> {
    const candidates = [...this.offers.values()]
      .filter((o) => o.status === "AGUARDANDO_ENVIO" && o.endpointId === endpointId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    for (const o of candidates) {
      o.status = "EM_PROCESSAMENTO_ENVIO";
      o.reservedAt = new Date();
    }
    return candidates.map((o) => this.snapshot(o));
  }

  async markDispatched(offerId: string): Promise<void> {
    const offer = this.require(offerId);
    offer.status = "ENVIADO";
    offer.reservedAt = null;
    this.processingLog.push({ offerId, etapa: "DISPARO", resultado: "SUCESSO" });
  }

  async markDispatchFailed(
    offerId: string,
    params: { proximaTentativaEm: Date | null; cancelar: boolean }
  ): Promise<void> {
    const offer = this.require(offerId);
    offer.status = params.cancelar ? "CANCELADO" : "ERRO_ENVIO";
    offer.reservedAt = null;
    offer.tentativasEnvio += 1;
    offer.proximaTentativaEm = params.proximaTentativaEm;
    this.processingLog.push({ offerId, etapa: "DISPARO", resultado: "FALHA" });
  }

  // ---------------------------------------------------------------------------
  // Worker 5 — RetryPort
  // ---------------------------------------------------------------------------
  async findRetryableOffers(limit: number): Promise<OfferSnapshot[]> {
    const now = Date.now();
    const candidates = [...this.offers.values()]
      .filter((o) => ERROR_STATUSES.includes(o.status))
      .filter((o) => !o.proximaTentativaEm || o.proximaTentativaEm.getTime() <= now)
      .slice(0, limit);
    return candidates.map((o) => this.snapshot(o));
  }

  async revertForRetry(offerId: string, targetStatus: string): Promise<void> {
    const offer = this.require(offerId);
    offer.status = targetStatus;
    offer.proximaTentativaEm = null;
  }

  // ---------------------------------------------------------------------------
  // Worker 6 — ReconciliationPort
  // ---------------------------------------------------------------------------
  async findStuckOffers(olderThanMs: number, limit: number): Promise<StuckOfferSnapshot[]> {
    const threshold = Date.now() - olderThanMs;
    const candidates = [...this.offers.values()]
      .filter((o) => o.reservedAt !== null && o.reservedAt.getTime() < threshold)
      .filter((o) => IN_FLIGHT_STATUSES.includes(o.status))
      .slice(0, limit);
    return candidates.map((o) => ({ ...this.snapshot(o), reservedAt: o.reservedAt }));
  }

  async releaseStuckOffer(offerId: string, targetStatus: string): Promise<void> {
    const offer = this.require(offerId);
    offer.status = targetStatus;
    offer.reservedAt = null;
  }
}
