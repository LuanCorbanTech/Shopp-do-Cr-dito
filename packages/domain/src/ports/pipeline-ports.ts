// Portas usadas pelos workers 1-6 (seção 6.1 do doc de arquitetura). Cada worker
// depende só da porta que precisa — implementações concretas (Prisma) vivem em
// @plataforma-ofertas/database. Mantém os workers testáveis com fakes em memória,
// nos mesmos moldes do OffersPort da Fase 1.

export interface OfferSnapshot {
  id: string;
  webhookId: string;
  externalId: string | null;
  cpf: string | null;
  telefoneOriginal: string | null;
  telefoneAtualizado: string | null;
  telefoneValidado: string | null;
  bancoAutorizado: string | null;
  produto: string | null;
  valor: number | null;
  parcelas: number | null;
  status: string;
  routingRuleId: string | null;
  endpointId: string | null;
  tentativasTelefone: number;
  tentativasWhatsapp: number;
  tentativasEnvio: number;
  whatsappRequestId: string | null;
  whatsappCheckIniciadoEm: Date | null;
}

// ---------------------------------------------------------------------------
// Configuração dinâmica (seção 27 do escopo original)
// ---------------------------------------------------------------------------

export interface IntegrationConfigSnapshot {
  chave: string;
  ativo: boolean;
  valor: Record<string, unknown>;
}

export interface IntegrationConfigPort {
  getConfig(chave: string): Promise<IntegrationConfigSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Worker 1 — Processamento inicial (Limit)
// ---------------------------------------------------------------------------

export interface PhoneProcessingPort {
  /** Reserva ofertas RECEBIDO -> PROCESSANDO_TELEFONE (SELECT FOR UPDATE SKIP LOCKED). */
  claimOffersReceived(limit: number): Promise<OfferSnapshot[]>;
  /** Limit (Lemit) desativado: usa telefone original e avança direto, registrando o motivo. */
  markPhoneSkippedLimitDisabled(offerId: string): Promise<void>;
  /** Limit (Lemit) ativado mas o lead não tem CPF — sem CPF não há como consultar; usa telefone original. */
  markPhoneSkippedSemDocumento(offerId: string): Promise<void>;
  /** Lemit respondeu com sucesso. */
  markPhoneUpdated(
    offerId: string,
    params: {
      // Nullable: se o lead chegou sem telefone na captação e a Lemit também não
      // devolveu um pra esse CPF, não há telefone nenhum disponível ainda (ver
      // guard em worker2-whatsapp.ts para esse caso).
      telefoneAtualizado: string | null;
      respostaBruta: unknown;
      /** Objeto "pessoa" completo devolvido pela Lemit — salvo direto no registro do lead. */
      dadosPessoa: Record<string, unknown> | null;
      /** Segundo a própria Lemit (informativo) — não substitui a validação oficial do Worker 2. */
      possuiWhatsappSegundoLemit: boolean | null;
      tentativa: number;
    }
  ): Promise<void>;
  /** Lemit falhou — agenda retry ou cancela se esgotou tentativas. */
  markPhoneFailed(
    offerId: string,
    params: { erro: string; tentativa: number; proximaTentativaEm: Date | null; cancelar: boolean }
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worker 2 — Validação WhatsApp
// ---------------------------------------------------------------------------

export interface WhatsappValidationPort {
  /** Reserva ofertas TELEFONE_ATUALIZADO -> VALIDANDO_WHATSAPP. */
  claimOffersForValidation(limit: number): Promise<OfferSnapshot[]>;
  /**
   * A API de validação é assíncrona (POST /check só devolve um request_id) —
   * isto registra que a consulta foi iniciada, para casar com o resultado
   * quando ele chegar (webhook ou consulta manual de fallback). A oferta
   * permanece em VALIDANDO_WHATSAPP.
   */
  markWhatsappCheckStarted(
    offerId: string,
    params: { requestId: string; telefoneUsado: string }
  ): Promise<void>;
  /** Usado pelo endpoint que recebe o webhook de callback, para achar a oferta pelo request_id. */
  findOfferByWhatsappRequestId(requestId: string): Promise<OfferSnapshot | null>;
  /**
   * Fallback: ofertas em VALIDANDO_WHATSAPP cujo request_id está há mais de
   * `olderThanMs` sem resposta (o webhook não chegou) — o Worker 2 busca o
   * resultado manualmente por essas (GET /check/{request_id}, disponível por 14 dias).
   */
  findOffersAwaitingWhatsappResult(params: {
    olderThanMs: number;
    limit: number;
    now?: Date;
  }): Promise<OfferSnapshot[]>;
  /** possuiWhatsapp=true avança para AGUARDANDO_ROTEAMENTO; false encerra em SEM_WHATSAPP. */
  markWhatsappValidated(
    offerId: string,
    params: { possuiWhatsapp: boolean; respostaBruta: unknown; telefoneUsado: string }
  ): Promise<void>;
  markWhatsappFailed(
    offerId: string,
    params: { erro: string; tentativa: number; proximaTentativaEm: Date | null; cancelar: boolean }
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worker 3 — Roteamento
// ---------------------------------------------------------------------------

export interface RoutingRuleSnapshot {
  id: string;
  condicoes: Record<string, unknown>;
  endpointId: string;
  prioridade: number;
}

export interface RoutingPort {
  /** Ofertas AGUARDANDO_ROTEAMENTO e SEM_ROTA_CONFIGURADA (reprocessa quando regra nova existe). */
  claimOffersForRouting(limit: number): Promise<OfferSnapshot[]>;
  listActiveRoutingRulesSortedByPriority(): Promise<RoutingRuleSnapshot[]>;
  isEndpointActive(endpointId: string): Promise<boolean>;
  assignRoute(offerId: string, params: { routingRuleId: string; endpointId: string }): Promise<void>;
  markNoRoute(offerId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worker 4 — Disparo
// ---------------------------------------------------------------------------

export interface EndpointSnapshot {
  id: string;
  nome: string;
  url: string;
  metodoHttp: string;
  headers: Record<string, string> | null;
  authType: string;
  credenciaisRef: string | null;
  capacidadeMinuto: number | null;
  capacidadeHora: number;
  capacidadeDia: number | null;
  timeoutMs: number;
  maxTentativas: number;
  ativo: boolean;
}

export interface DispatchPort {
  listActiveEndpoints(): Promise<EndpointSnapshot[]>;
  /** Reserva ofertas AGUARDANDO_ENVIO de um endpoint -> EM_PROCESSAMENTO_ENVIO. */
  claimOffersForDispatch(endpointId: string, limit: number): Promise<OfferSnapshot[]>;
  markDispatched(
    offerId: string,
    params: {
      endpointId: string;
      request: unknown;
      response: unknown;
      httpStatus: number | null;
      tentativa: number;
    }
  ): Promise<void>;
  markDispatchFailed(
    offerId: string,
    params: {
      endpointId: string;
      request: unknown;
      response: unknown;
      httpStatus: number | null;
      erro: string;
      tentativa: number;
      proximaTentativaEm: Date | null;
      cancelar: boolean;
    }
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worker 5 — Retry
// ---------------------------------------------------------------------------

export interface RetryPort {
  /** status em ERRO_* com proximaTentativaEm nula ou já passada. */
  findRetryableOffers(limit: number): Promise<OfferSnapshot[]>;
  /** Devolve a oferta ao estado que faz o worker correspondente reprocessá-la. */
  revertForRetry(offerId: string, targetStatus: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worker 6 — Reconciliação
// ---------------------------------------------------------------------------

export interface StuckOfferSnapshot extends OfferSnapshot {
  reservedAt: Date | null;
}

export interface ReconciliationPort {
  /** Ofertas em estado transitório (EM_PROCESSAMENTO_*) travadas há mais que o SLA. */
  findStuckOffers(olderThanMs: number, limit: number): Promise<StuckOfferSnapshot[]>;
  releaseStuckOffer(offerId: string, targetStatus: string): Promise<void>;
}
