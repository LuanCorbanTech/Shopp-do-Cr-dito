import { Prisma, type PrismaClient, type OfferStatus } from "@prisma/client";
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
  DispatchPollPort,
  InfoPessoaLemit,
} from "@plataforma-ofertas/domain";

// Implementação Prisma/PostgreSQL de todas as portas usadas pelos workers 1-6.
// A reserva de ofertas usa SQL bruto (UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
// SKIP LOCKED) RETURNING ...) porque o Prisma Client não expõe FOR UPDATE SKIP LOCKED
// na API de alto nível — é exatamente a estratégia descrita na seção 6.3 do doc de
// arquitetura, e garante que dois workers nunca peguem a mesma oferta.

type OfferRow = {
  id: string;
  webhookId: string;
  externalId: string | null;
  nome: string | null;
  cpf: string | null;
  dataNascimento: Date | null;
  telefoneOriginal: string | null;
  telefoneAtualizado: string | null;
  telefoneValidado: string | null;
  possuiWhatsapp: boolean | null;
  bancoAutorizado: string | null;
  produto: string | null;
  valor: Prisma.Decimal | number | null;
  parcelas: number | null;
  status: string;
  routingRuleId: string | null;
  endpointId: string | null;
  tentativasTelefone: number;
  tentativasWhatsapp: number;
  tentativasEnvio: number;
  reservedAt?: Date | null;
  whatsappRequestId: string | null;
  whatsappCheckIniciadoEm: Date | null;
};

const OFFER_COLUMNS_SQL = Prisma.sql`
  id, webhook_id AS "webhookId", external_id AS "externalId", nome, cpf,
  data_nascimento AS "dataNascimento",
  telefone_original AS "telefoneOriginal", telefone_atualizado AS "telefoneAtualizado",
  telefone_validado AS "telefoneValidado", possui_whatsapp AS "possuiWhatsapp",
  banco_autorizado AS "bancoAutorizado",
  produto, valor, parcelas, status::text AS status,
  routing_rule_id AS "routingRuleId", endpoint_id AS "endpointId",
  tentativas_telefone AS "tentativasTelefone", tentativas_whatsapp AS "tentativasWhatsapp",
  tentativas_envio AS "tentativasEnvio", reserved_at AS "reservedAt",
  whatsapp_request_id AS "whatsappRequestId", whatsapp_check_iniciado_em AS "whatsappCheckIniciadoEm"
`;

function mapRow(row: OfferRow): OfferSnapshot {
  return {
    id: row.id,
    webhookId: row.webhookId,
    externalId: row.externalId,
    nome: row.nome,
    cpf: row.cpf,
    dataNascimento: row.dataNascimento,
    telefoneOriginal: row.telefoneOriginal,
    telefoneAtualizado: row.telefoneAtualizado,
    telefoneValidado: row.telefoneValidado,
    possuiWhatsapp: row.possuiWhatsapp,
    bancoAutorizado: row.bancoAutorizado,
    produto: row.produto,
    valor: row.valor === null ? null : Number(row.valor),
    parcelas: row.parcelas,
    status: row.status,
    routingRuleId: row.routingRuleId,
    endpointId: row.endpointId,
    tentativasTelefone: row.tentativasTelefone,
    tentativasWhatsapp: row.tentativasWhatsapp,
    tentativasEnvio: row.tentativasEnvio,
    whatsappRequestId: row.whatsappRequestId,
    whatsappCheckIniciadoEm: row.whatsappCheckIniciadoEm,
  };
}

export class PrismaPipelineRepository
  implements
    IntegrationConfigPort,
    PhoneProcessingPort,
    WhatsappValidationPort,
    RoutingPort,
    DispatchPort,
    RetryPort,
    ReconciliationPort,
    DispatchPollPort
{
  constructor(private readonly prisma: PrismaClient) {}

  private async claimByStatus(
    fromStatuses: string[],
    toStatus: string,
    limit: number
  ): Promise<OfferSnapshot[]> {
    const statusesSql = Prisma.join(fromStatuses.map((s) => Prisma.sql`${s}::"OfferStatus"`));
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      UPDATE offers
      SET status = ${toStatus}::"OfferStatus", reserved_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM offers
        WHERE status IN (${statusesSql})
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING ${OFFER_COLUMNS_SQL}
    `;
    return rows.map(mapRow);
  }

  // -------------------------------------------------------------------------
  // IntegrationConfigPort
  // -------------------------------------------------------------------------

  async getConfig(chave: string): Promise<IntegrationConfigSnapshot | null> {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave } });
    if (!config) return null;
    return { chave: config.chave, ativo: config.ativo, valor: (config.valor as Record<string, unknown>) ?? {} };
  }

  // -------------------------------------------------------------------------
  // Worker 1 — Limit
  // -------------------------------------------------------------------------

  async claimOffersReceived(limit: number): Promise<OfferSnapshot[]> {
    return this.claimByStatus(["RECEBIDO"], "PROCESSANDO_TELEFONE", limit);
  }

  async markPhoneSkippedLimitDisabled(offerId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: { status: "TELEFONE_ATUALIZADO", reservedAt: null },
      }),
      this.prisma.phoneValidation.create({
        data: { offerId, limitAtivoNoMomento: false },
      }),
      this.prisma.offerProcessing.create({
        data: { offerId, etapa: "LIMIT", resultado: "IGNORADO", tentativa: 1 },
      }),
    ]);
  }

  async markPhoneUpdated(
    offerId: string,
    params: {
      telefoneAtualizado: string | null;
      respostaBruta: unknown;
      dadosPessoa: Record<string, unknown> | null;
      infoPessoa: InfoPessoaLemit;
      possuiWhatsappSegundoLemit: boolean | null;
      tentativa: number;
    }
  ): Promise<void> {
    const info = params.infoPessoa;
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: {
          status: "TELEFONE_ATUALIZADO",
          telefoneAtualizado: params.telefoneAtualizado,
          dadosPessoaLemit: toJsonInput(params.dadosPessoa),
          // "undefined" (não "null") quando a Lemit não devolve nome — assim o
          // Prisma simplesmente NÃO toca nesse campo, mantendo o que já existia
          // em vez de apagar (pedido explícito: só atualiza quando tem valor).
          nome: info.nome ?? undefined,
          dataNascimento: info.dataNascimento,
          sexo: info.sexo,
          nomeMae: info.nomeMae,
          email: info.email,
          telefoneLemit: info.telefone,
          whatsappLemit: info.whatsapp,
          endereco: info.endereco,
          uf: info.uf,
          cep: info.cep,
          bairro: info.bairro,
          cidade: info.cidade,
          numero: info.numero,
          logradouro: info.logradouro,
          complemento: info.complemento,
          reservedAt: null,
        },
      }),
      this.prisma.phoneValidation.create({
        data: {
          offerId,
          limitAtivoNoMomento: true,
          respostaLimit: toJsonInput(params.respostaBruta),
          possuiWhatsapp: params.possuiWhatsappSegundoLemit,
        },
      }),
      this.prisma.offerProcessing.create({
        data: {
          offerId,
          etapa: "LIMIT",
          resultado: "SUCESSO",
          response: toJsonInput(params.respostaBruta),
          tentativa: params.tentativa,
        },
      }),
    ]);
  }

  async markPhoneSkippedSemDocumento(offerId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: { status: "TELEFONE_ATUALIZADO", reservedAt: null },
      }),
      this.prisma.phoneValidation.create({
        data: { offerId, limitAtivoNoMomento: true },
      }),
      this.prisma.offerProcessing.create({
        data: { offerId, etapa: "LIMIT", resultado: "SEM_DOCUMENTO", tentativa: 1 },
      }),
    ]);
  }

  async markPhoneFailed(
    offerId: string,
    params: { erro: string; tentativa: number; proximaTentativaEm: Date | null; cancelar: boolean; respostaBruta?: unknown }
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: {
          status: params.cancelar ? "CANCELADO" : "ERRO_TELEFONE",
          reservedAt: null,
          tentativasTelefone: { increment: 1 },
          proximaTentativaEm: params.proximaTentativaEm,
        },
      }),
      this.prisma.offerProcessing.create({
        data: {
          offerId,
          etapa: "LIMIT",
          resultado: "FALHA",
          response: params.respostaBruta != null ? { erro: params.erro, respostaBruta: toJsonInput(params.respostaBruta) } : { erro: params.erro },
          tentativa: params.tentativa,
        },
      }),
    ]);
  }

  async markPhoneCpfInvalido(offerId: string, respostaBruta?: unknown): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: {
          status: "CPF_INVALIDO",
          reservedAt: null,
          tentativasTelefone: { increment: 1 },
          proximaTentativaEm: null, // terminal — nunca reagenda
        },
      }),
      this.prisma.offerProcessing.create({
        data: {
          offerId,
          etapa: "LIMIT",
          resultado: "CPF_INVALIDO",
          response:
            respostaBruta != null
              ? { erro: "CPF não encontrado na base da Lemit (404)", respostaBruta: toJsonInput(respostaBruta) }
              : { erro: "CPF não encontrado na base da Lemit (404)" },
          tentativa: 1,
        },
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Worker 2 — Validação WhatsApp
  // -------------------------------------------------------------------------

  async claimOffersForValidation(limit: number): Promise<OfferSnapshot[]> {
    return this.claimByStatus(["TELEFONE_ATUALIZADO"], "VALIDANDO_WHATSAPP", limit);
  }

  async markWhatsappCheckStarted(
    offerId: string,
    params: { requestId: string; telefoneUsado: string; respostaBruta?: unknown }
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: {
          whatsappRequestId: params.requestId,
          whatsappCheckIniciadoEm: new Date(),
          reservedAt: null,
        },
      }),
      this.prisma.offerProcessing.create({
        data: {
          offerId,
          etapa: "WHATSAPP",
          resultado: "CONSULTA_INICIADA",
          response: toJsonInput(params.respostaBruta ?? { requestId: params.requestId }),
          tentativa: 1,
        },
      }),
    ]);
  }

  async findOfferByWhatsappRequestId(requestId: string): Promise<OfferSnapshot | null> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      SELECT ${OFFER_COLUMNS_SQL} FROM offers WHERE whatsapp_request_id = ${requestId} LIMIT 1
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findOffersAwaitingWhatsappResult(params: {
    olderThanMs: number;
    limit: number;
    now?: Date;
  }): Promise<OfferSnapshot[]> {
    const cutoff = new Date((params.now ?? new Date()).getTime() - params.olderThanMs);
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      SELECT ${OFFER_COLUMNS_SQL} FROM offers
      WHERE status = 'VALIDANDO_WHATSAPP'::"OfferStatus"
        AND whatsapp_request_id IS NOT NULL
        AND whatsapp_check_iniciado_em < ${cutoff}
      ORDER BY whatsapp_check_iniciado_em
      LIMIT ${params.limit}
    `;
    return rows.map(mapRow);
  }

  async markWhatsappValidated(
    offerId: string,
    params: { possuiWhatsapp: boolean; respostaBruta: unknown; telefoneUsado: string }
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: {
          // Novo modelo (17/08): sucesso vai direto pra AGUARDANDO_DISPARO — não
          // existe mais motor de roteamento interno (ver DispatchPollPort).
          status: params.possuiWhatsapp ? "AGUARDANDO_DISPARO" : "SEM_WHATSAPP",
          telefoneValidado: params.possuiWhatsapp ? params.telefoneUsado : null,
          possuiWhatsapp: params.possuiWhatsapp,
          whatsappRequestId: null,
          whatsappCheckIniciadoEm: null,
          reservedAt: null,
        },
      }),
      this.prisma.phoneValidation.updateMany({
        where: { offerId },
        data: { possuiWhatsapp: params.possuiWhatsapp },
      }),
      this.prisma.offerProcessing.create({
        data: {
          offerId,
          etapa: "WHATSAPP",
          resultado: params.possuiWhatsapp ? "SUCESSO" : "SEM_WHATSAPP",
          response: toJsonInput(params.respostaBruta),
          tentativa: 1,
        },
      }),
    ]);
  }

  async markWhatsappFailed(
    offerId: string,
    params: { erro: string; tentativa: number; proximaTentativaEm: Date | null; cancelar: boolean; respostaBruta?: unknown }
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: {
          status: params.cancelar ? "CANCELADO" : "ERRO_VALIDACAO_WHATSAPP",
          whatsappRequestId: null,
          whatsappCheckIniciadoEm: null,
          reservedAt: null,
          tentativasWhatsapp: { increment: 1 },
          proximaTentativaEm: params.proximaTentativaEm,
        },
      }),
      this.prisma.offerProcessing.create({
        data: {
          offerId,
          etapa: "WHATSAPP",
          resultado: "FALHA",
          response: toJsonInput(params.respostaBruta ?? { erro: params.erro }),
          tentativa: params.tentativa,
        },
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Worker 3 — Roteamento
  // -------------------------------------------------------------------------

  async claimOffersForRouting(limit: number): Promise<OfferSnapshot[]> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      UPDATE offers
      SET reserved_at = now()
      WHERE id IN (
        SELECT id FROM offers
        WHERE status IN ('AGUARDANDO_ROTEAMENTO'::"OfferStatus", 'SEM_ROTA_CONFIGURADA'::"OfferStatus")
          AND reserved_at IS NULL
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING ${OFFER_COLUMNS_SQL}
    `;
    return rows.map(mapRow);
  }

  async listActiveRoutingRulesSortedByPriority(): Promise<RoutingRuleSnapshot[]> {
    const rules = await this.prisma.routingRule.findMany({
      where: { ativo: true },
      orderBy: { prioridade: "asc" },
    });
    return rules.map((r) => ({
      id: r.id,
      condicoes: (r.condicoes as Record<string, unknown>) ?? {},
      endpointId: r.endpointId,
      prioridade: r.prioridade,
    }));
  }

  async isEndpointActive(endpointId: string): Promise<boolean> {
    const endpoint = await this.prisma.endpoint.findUnique({ where: { id: endpointId } });
    return Boolean(endpoint?.ativo);
  }

  async assignRoute(
    offerId: string,
    params: { routingRuleId: string; endpointId: string }
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: {
          status: "AGUARDANDO_ENVIO",
          routingRuleId: params.routingRuleId,
          endpointId: params.endpointId,
          reservedAt: null,
        },
      }),
      this.prisma.offerProcessing.create({
        data: { offerId, etapa: "ROTEAMENTO", resultado: "SUCESSO", tentativa: 1 },
      }),
    ]);
  }

  async markNoRoute(offerId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: { status: "SEM_ROTA_CONFIGURADA", reservedAt: null },
      }),
      this.prisma.offerProcessing.create({
        data: { offerId, etapa: "ROTEAMENTO", resultado: "SEM_ROTA", tentativa: 1 },
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Worker 4 — Disparo
  // -------------------------------------------------------------------------

  async listActiveEndpoints(): Promise<EndpointSnapshot[]> {
    const endpoints = await this.prisma.endpoint.findMany({ where: { ativo: true } });
    return endpoints.map((e) => ({
      id: e.id,
      nome: e.nome,
      url: e.url,
      metodoHttp: e.metodoHttp,
      headers: (e.headers as Record<string, string> | null) ?? null,
      authType: e.authType,
      credenciaisRef: e.credenciaisRef,
      capacidadeMinuto: e.capacidadeMinuto,
      capacidadeHora: e.capacidadeHora,
      capacidadeDia: e.capacidadeDia,
      timeoutMs: e.timeoutMs,
      maxTentativas: e.maxTentativas,
      ativo: e.ativo,
    }));
  }

  async claimOffersForDispatch(endpointId: string, limit: number): Promise<OfferSnapshot[]> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      UPDATE offers
      SET status = 'EM_PROCESSAMENTO_ENVIO'::"OfferStatus", reserved_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM offers
        WHERE status = 'AGUARDANDO_ENVIO'::"OfferStatus" AND endpoint_id = ${endpointId}
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING ${OFFER_COLUMNS_SQL}
    `;
    return rows.map(mapRow);
  }

  async markDispatched(
    offerId: string,
    params: {
      endpointId: string;
      request: unknown;
      response: unknown;
      httpStatus: number | null;
      tentativa: number;
    }
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: { status: "ENVIADO", reservedAt: null },
      }),
      this.prisma.dispatch.create({
        data: {
          offerId,
          endpointId: params.endpointId,
          request: toJsonInput(params.request),
          response: toJsonInput(params.response),
          httpStatus: params.httpStatus,
          tentativa: params.tentativa,
          status: "SUCESSO",
        },
      }),
      this.prisma.offerProcessing.create({
        data: {
          offerId,
          etapa: "DISPARO",
          resultado: "SUCESSO",
          httpStatus: params.httpStatus,
          response: toJsonInput(params.response),
          tentativa: params.tentativa,
        },
      }),
    ]);
  }

  async markDispatchFailed(
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
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: {
          status: params.cancelar ? "CANCELADO" : "ERRO_ENVIO",
          reservedAt: null,
          tentativasEnvio: { increment: 1 },
          proximaTentativaEm: params.proximaTentativaEm,
        },
      }),
      this.prisma.dispatch.create({
        data: {
          offerId,
          endpointId: params.endpointId,
          request: toJsonInput(params.request),
          response: toJsonInput(params.response),
          httpStatus: params.httpStatus,
          tentativa: params.tentativa,
          status: params.cancelar ? "FALHA" : "RETRYING",
        },
      }),
      this.prisma.offerProcessing.create({
        data: {
          offerId,
          etapa: "DISPARO",
          resultado: "FALHA",
          httpStatus: params.httpStatus,
          response: { erro: params.erro },
          tentativa: params.tentativa,
        },
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Worker 5 — Retry
  // -------------------------------------------------------------------------

  async findRetryableOffers(limit: number): Promise<OfferSnapshot[]> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      SELECT ${OFFER_COLUMNS_SQL} FROM offers
      WHERE status IN ('ERRO_TELEFONE'::"OfferStatus", 'ERRO_VALIDACAO_WHATSAPP'::"OfferStatus", 'ERRO_ENVIO'::"OfferStatus")
        AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= now())
      ORDER BY updated_at
      LIMIT ${limit}
    `;
    return rows.map(mapRow);
  }

  async revertForRetry(offerId: string, targetStatus: string): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: { status: targetStatus as OfferStatus, proximaTentativaEm: null },
    });
  }

  // -------------------------------------------------------------------------
  // Worker 6 — Reconciliação
  // -------------------------------------------------------------------------

  async findStuckOffers(olderThanMs: number, limit: number): Promise<StuckOfferSnapshot[]> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      SELECT ${OFFER_COLUMNS_SQL} FROM offers
      WHERE reserved_at IS NOT NULL
        AND reserved_at < now() - (${olderThanMs}::text || ' milliseconds')::interval
        AND status IN (
          'PROCESSANDO_TELEFONE'::"OfferStatus", 'VALIDANDO_WHATSAPP'::"OfferStatus",
          'EM_PROCESSAMENTO_ENVIO'::"OfferStatus", 'AGUARDANDO_ROTEAMENTO'::"OfferStatus",
          'SEM_ROTA_CONFIGURADA'::"OfferStatus"
        )
      ORDER BY reserved_at
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...mapRow(row), reservedAt: row.reservedAt ?? null }));
  }

  async releaseStuckOffer(offerId: string, targetStatus: string): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: { status: targetStatus as OfferStatus, reservedAt: null },
    });
  }

  // -------------------------------------------------------------------------
  // Endpoint de disparo por polling externo — DispatchPollPort
  // -------------------------------------------------------------------------

  async claimOffersAguardandoDisparo(limit: number): Promise<OfferSnapshot[]> {
    // Mesmo padrão atômico de claimByStatus (UPDATE...RETURNING com FOR UPDATE
    // SKIP LOCKED) — chamadas concorrentes ao endpoint nunca pegam a mesma
    // oferta. DISPARO_CONSULTADO é terminal: a oferta nunca mais aparece aqui.
    return this.claimByStatus(["AGUARDANDO_DISPARO"], "DISPARO_CONSULTADO", limit);
  }

  // Chamado pelo endpoint POST /api/v1/leads/status — busca por id (nosso) OU
  // externalId (do parceiro), o que vier preenchido. Devolve null se não
  // achou a oferta (o endpoint traduz isso pra 404). De propósito NÃO valida
  // a transição de status anterior (ex.: aceita ir direto pra
  // DISPARO_RESPONDIDO mesmo sem ter passado por DISPARO_ENVIADO antes) —
  // um evento real do lado do parceiro não deve ser rejeitado só por causa
  // de uma etapa de bookkeeping que porventura não chegou antes.
  async atualizarStatusDisparo(params: {
    id?: string;
    externalId?: string;
    novoStatus: "DISPARO_ENVIADO" | "DISPARO_RESPONDIDO";
  }): Promise<OfferSnapshot | null> {
    if (!params.id && !params.externalId) return null;
    const whereSql = params.id ? Prisma.sql`id = ${params.id}` : Prisma.sql`external_id = ${params.externalId}`;
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      UPDATE offers
      SET status = ${params.novoStatus}::"OfferStatus", updated_at = now()
      WHERE ${whereSql}
      RETURNING ${OFFER_COLUMNS_SQL}
    `;
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}
