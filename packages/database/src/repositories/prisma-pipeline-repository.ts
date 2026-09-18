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
  OfferParaDisparoSnapshot,
  DispatchPollPort,
  InfoPessoaLemit,
  MargemFactaPort,
  OfertaParaMargemSnapshot,
  MargemFactaOnlinePort,
  OfertaParaOnlineFactaSnapshot,
  ProporcaoDisparoPort,
  ConfiguracaoProporcaoDisparoSnapshot,
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
  whatsappLoteId: string | null;
  whatsappCheckIniciadoEm: Date | null;
  pularValidacaoLemit: boolean;
  pularValidacaoWhatsapp: boolean;
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
  whatsapp_request_id AS "whatsappRequestId", whatsapp_lote_id AS "whatsappLoteId",
  whatsapp_check_iniciado_em AS "whatsappCheckIniciadoEm",
  pular_validacao_lemit AS "pularValidacaoLemit", pular_validacao_whatsapp AS "pularValidacaoWhatsapp"
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
    whatsappLoteId: row.whatsappLoteId,
    whatsappCheckIniciadoEm: row.whatsappCheckIniciadoEm,
    pularValidacaoLemit: row.pularValidacaoLemit,
    pularValidacaoWhatsapp: row.pularValidacaoWhatsapp,
  };
}

// "fornecedor" no disparo (18/09) — só as 2 consultas que alimentam o
// disparo (claimAguardandoDisparoSemProporcao e claimOneAguardandoDisparoPorTipo,
// por baixo de claimOffersAguardandoDisparo) precisam desse campo extra, então
// em vez de mexer no OFFER_COLUMNS_SQL/OfferRow/mapRow genéricos (reusados por
// TODAS as outras consultas do pipeline, que não têm nenhuma relação com
// disparo), essas 2 consultas fazem JOIN com webhooks e usam esse conjunto de
// colunas à parte — com "offers." explícito no id pra não ficar ambíguo com o
// id da tabela webhooks depois do JOIN.
type OfferRowComFornecedor = OfferRow & { fornecedor: string };

const OFFER_COLUMNS_COM_FORNECEDOR_SQL = Prisma.sql`
  offers.id, offers.webhook_id AS "webhookId", offers.external_id AS "externalId", offers.nome, offers.cpf,
  offers.data_nascimento AS "dataNascimento",
  offers.telefone_original AS "telefoneOriginal", offers.telefone_atualizado AS "telefoneAtualizado",
  offers.telefone_validado AS "telefoneValidado", offers.possui_whatsapp AS "possuiWhatsapp",
  offers.banco_autorizado AS "bancoAutorizado",
  offers.produto, offers.valor, offers.parcelas, offers.status::text AS status,
  offers.routing_rule_id AS "routingRuleId", offers.endpoint_id AS "endpointId",
  offers.tentativas_telefone AS "tentativasTelefone", offers.tentativas_whatsapp AS "tentativasWhatsapp",
  offers.tentativas_envio AS "tentativasEnvio", offers.reserved_at AS "reservedAt",
  offers.whatsapp_request_id AS "whatsappRequestId", offers.whatsapp_lote_id AS "whatsappLoteId",
  offers.whatsapp_check_iniciado_em AS "whatsappCheckIniciadoEm",
  offers.pular_validacao_lemit AS "pularValidacaoLemit", offers.pular_validacao_whatsapp AS "pularValidacaoWhatsapp",
  CASE WHEN w.tipo = 'BASE_UPLOAD'::"OrigemWebhookTipo" THEN 'base_upload' ELSE w.identificador END AS "fornecedor"
`;

function mapRowParaDisparo(row: OfferRowComFornecedor): OfferParaDisparoSnapshot {
  return { ...mapRow(row), fornecedor: row.fornecedor };
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
    DispatchPollPort,
    MargemFactaPort,
    MargemFactaOnlinePort,
    ProporcaoDisparoPort
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
    return this.claimByStatus(["MARGEM_APROVADA"], "PROCESSANDO_TELEFONE", limit);
  }

  // Segunda chance (02/09) — mesmo padrão atômico de claimByStatus
  // (SKIP LOCKED), mas com um filtro extra que o método genérico não
  // suporta (telefone_atualizado IS NULL), por isso precisa de SQL próprio
  // em vez de reusar claimByStatus.
  async claimOffersSemWhatsappParaRetentarLemit(limit: number): Promise<OfferSnapshot[]> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      UPDATE offers
      SET status = 'PROCESSANDO_TELEFONE'::"OfferStatus", reserved_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM offers
        WHERE status = 'SEM_WHATSAPP'::"OfferStatus" AND telefone_atualizado IS NULL
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING ${OFFER_COLUMNS_SQL}
    `;
    return rows.map(mapRow);
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

  // Base de upload (18/09) — mesmo padrão atômico de claimByStatus, mas só
  // pra ofertas marcadas pra pular a validação de WhatsApp (filtro extra
  // que o método genérico não suporta, por isso SQL próprio, igual
  // claimOffersSemWhatsappParaRetentarLemit acima).
  async claimOffersParaPularValidacao(limit: number): Promise<OfferSnapshot[]> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      UPDATE offers
      SET status = 'VALIDANDO_WHATSAPP'::"OfferStatus", reserved_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM offers
        WHERE status = 'TELEFONE_ATUALIZADO'::"OfferStatus" AND pular_validacao_whatsapp = true
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING ${OFFER_COLUMNS_SQL}
    `;
    return rows.map(mapRow);
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

  // -------------------------------------------------------------------------
  // Consulta em LOTE (ver comentário na interface WhatsappValidationPort)
  // -------------------------------------------------------------------------

  async countOffersAwaitingValidation(): Promise<{ total: number; esperandoDesde: Date | null }> {
    const rows = await this.prisma.$queryRaw<{ total: bigint; esperandoDesde: Date | null }[]>`
      SELECT count(*) AS total, min(updated_at) AS "esperandoDesde"
      FROM offers
      WHERE status = 'TELEFONE_ATUALIZADO'::"OfferStatus"
    `;
    return { total: Number(rows[0]?.total ?? 0), esperandoDesde: rows[0]?.esperandoDesde ?? null };
  }

  async markWhatsappLoteCheckStarted(params: { offerIds: string[]; loteId: string }): Promise<void> {
    if (params.offerIds.length === 0) return;
    await this.prisma.$transaction([
      this.prisma.offer.updateMany({
        where: { id: { in: params.offerIds } },
        data: { whatsappLoteId: params.loteId, whatsappCheckIniciadoEm: new Date(), reservedAt: null },
      }),
      this.prisma.offerProcessing.createMany({
        data: params.offerIds.map((offerId) => ({
          offerId,
          etapa: "WHATSAPP",
          resultado: "CONSULTA_LOTE_INICIADA",
          response: toJsonInput({ loteId: params.loteId }),
          tentativa: 1,
        })),
      }),
    ]);
  }

  async findLotesAwaitingWhatsappResult(params: { olderThanMs: number; limit: number; now?: Date }): Promise<string[]> {
    const cutoff = new Date((params.now ?? new Date()).getTime() - params.olderThanMs);
    const rows = await this.prisma.$queryRaw<{ whatsappLoteId: string }[]>`
      SELECT DISTINCT whatsapp_lote_id AS "whatsappLoteId"
      FROM offers
      WHERE status = 'VALIDANDO_WHATSAPP'::"OfferStatus"
        AND whatsapp_lote_id IS NOT NULL
        AND whatsapp_check_iniciado_em < ${cutoff}
      ORDER BY "whatsappLoteId"
      LIMIT ${params.limit}
    `;
    return rows.map((r) => r.whatsappLoteId);
  }

  async findOffersByWhatsappLoteId(loteId: string): Promise<OfferSnapshot[]> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      SELECT ${OFFER_COLUMNS_SQL} FROM offers WHERE whatsapp_lote_id = ${loteId}
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
          whatsappLoteId: null,
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
          whatsappLoteId: null,
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

  // Proporção de disparo (18/09) — pedido explícito: "a cada 1 lead
  // disparado de fornecedor webhook, disparar N de base upload". Chamado
  // tanto pelo worker8 (empurra pros endpoints) quanto pelo GET
  // /api/v1/leads/aguardando-disparo (puxado por fora) — os dois usam esse
  // MESMO método, então a proporção vale pra qualquer um dos dois sem
  // precisar saber qual está realmente em uso.
  //
  // Sem proporção configurada (pesos iguais, ou algum <= 0 — nunca deveria
  // acontecer pela tela, mas defensivo) usa o caminho RÁPIDO de sempre (1
  // UPDATE só, em lote) — sem discriminar origem, idêntico ao
  // comportamento antigo. Com proporção de verdade, precisa reivindicar
  // ofertas UMA POR VEZ (decidindo a cada uma de qual origem tirar,
  // olhando pro histórico desde que a proporção foi configurada), porque
  // não dá pra saber de antemão quantas de cada tipo existem disponíveis.
  async claimOffersAguardandoDisparo(limit: number): Promise<OfferParaDisparoSnapshot[]> {
    if (limit <= 0) return [];
    const config = await this.buscarConfiguracaoProporcao();
    const semProporcao =
      config.pesoFornecedor <= 0 || config.pesoUpload <= 0 || config.pesoFornecedor === config.pesoUpload;
    if (semProporcao) {
      return this.claimAguardandoDisparoSemProporcao(limit);
    }

    let contFornecedor = await this.contarDisparadosPorTipoDesde("FORNECEDOR", config.vigenteDesde);
    let contUpload = await this.contarDisparadosPorTipoDesde("BASE_UPLOAD", config.vigenteDesde);

    const resultado: OfferParaDisparoSnapshot[] = [];
    for (let i = 0; i < limit; i++) {
      // Quem estiver mais "atrasado" em relação ao peso configurado (menor
      // razão contagem/peso) tira a vez primeiro — round-robin ponderado
      // clássico, sem precisar de contador/estado próprio: o histórico
      // desde vigenteDesde JÁ É o estado.
      const razaoFornecedor = contFornecedor / config.pesoFornecedor;
      const razaoUpload = contUpload / config.pesoUpload;
      const preferido: "FORNECEDOR" | "BASE_UPLOAD" = razaoFornecedor <= razaoUpload ? "FORNECEDOR" : "BASE_UPLOAD";
      const alternativo: "FORNECEDOR" | "BASE_UPLOAD" = preferido === "FORNECEDOR" ? "BASE_UPLOAD" : "FORNECEDOR";

      let oferta = await this.claimOneAguardandoDisparoPorTipo(preferido);
      let tipoClaimado = preferido;
      if (!oferta) {
        // Fila preferida vazia — pedido explícito: nunca trava esperando
        // ela ter lead, dispara da outra origem mesmo assim.
        oferta = await this.claimOneAguardandoDisparoPorTipo(alternativo);
        tipoClaimado = alternativo;
      }
      if (!oferta) break; // as duas filas esvaziaram — para, devolve o que já pegou até aqui.

      resultado.push(oferta);
      if (tipoClaimado === "FORNECEDOR") contFornecedor += 1;
      else contUpload += 1;
    }
    return resultado;
  }

  private async claimAguardandoDisparoSemProporcao(limit: number): Promise<OfferParaDisparoSnapshot[]> {
    // Mesmo padrão atômico de claimByStatus (UPDATE...RETURNING com FOR UPDATE
    // SKIP LOCKED) — chamadas concorrentes ao endpoint nunca pegam a mesma
    // oferta. DISPARO_CONSULTADO é terminal: a oferta nunca mais aparece aqui.
    // disparo_consultado_em marcado igual ao caminho com proporção, pra
    // manter o contador consistente se a proporção for ativada depois.
    // JOIN com webhooks (18/09) só pra devolver o "fornecedor" — usa UPDATE
    // ... FROM (join) pra poder incluir a coluna computada no RETURNING; a
    // seleção/travamento das linhas (SKIP LOCKED) continua olhando só pra
    // offers, sem mudança de comportamento nenhuma.
    const rows = await this.prisma.$queryRaw<OfferRowComFornecedor[]>`
      UPDATE offers
      SET status = 'DISPARO_CONSULTADO'::"OfferStatus", disparo_consultado_em = now(), updated_at = now()
      FROM webhooks w
      WHERE offers.webhook_id = w.id
        AND offers.id IN (
          SELECT id FROM offers
          WHERE status = 'AGUARDANDO_DISPARO'::"OfferStatus"
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
      RETURNING ${OFFER_COLUMNS_COM_FORNECEDOR_SQL}
    `;
    return rows.map(mapRowParaDisparo);
  }

  private async claimOneAguardandoDisparoPorTipo(
    tipo: "FORNECEDOR" | "BASE_UPLOAD"
  ): Promise<OfferParaDisparoSnapshot | null> {
    // Mesmo JOIN-pra-RETURNING de claimAguardandoDisparoSemProporcao acima —
    // a subquery mantém seu próprio JOIN (alias w2) só pra filtrar por tipo;
    // o JOIN externo (alias w) é só pra expor "fornecedor" no RETURNING.
    const rows = await this.prisma.$queryRaw<OfferRowComFornecedor[]>`
      UPDATE offers
      SET status = 'DISPARO_CONSULTADO'::"OfferStatus", disparo_consultado_em = now(), updated_at = now()
      FROM webhooks w
      WHERE offers.webhook_id = w.id
        AND offers.id = (
          SELECT o.id FROM offers o
          JOIN webhooks w2 ON w2.id = o.webhook_id
          WHERE o.status = 'AGUARDANDO_DISPARO'::"OfferStatus" AND w2.tipo = ${tipo}::"OrigemWebhookTipo"
          ORDER BY o.created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
      RETURNING ${OFFER_COLUMNS_COM_FORNECEDOR_SQL}
    `;
    return rows[0] ? mapRowParaDisparo(rows[0]) : null;
  }

  private async contarDisparadosPorTipoDesde(tipo: "FORNECEDOR" | "BASE_UPLOAD", desde: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total
      FROM offers o
      JOIN webhooks w ON w.id = o.webhook_id
      WHERE w.tipo = ${tipo}::"OrigemWebhookTipo" AND o.disparo_consultado_em >= ${desde}
    `;
    return Number(rows[0]?.total ?? 0);
  }

  // -------------------------------------------------------------------------
  // Proporção de disparo — ProporcaoDisparoPort
  // -------------------------------------------------------------------------

  async buscarConfiguracaoProporcao(): Promise<ConfiguracaoProporcaoDisparoSnapshot> {
    const atual = await this.prisma.configuracaoProporcaoDisparo.findFirst({ orderBy: { vigenteDesde: "asc" } });
    if (!atual) {
      // Defensivo — a migração sempre semeia 1 linha (1:1, sem preferência);
      // nunca deveria faltar, mas nunca deixa o disparo travado por isso.
      return { pesoFornecedor: 1, pesoUpload: 1, vigenteDesde: new Date(0) };
    }
    return { pesoFornecedor: atual.pesoFornecedor, pesoUpload: atual.pesoUpload, vigenteDesde: atual.vigenteDesde };
  }

  async definirConfiguracaoProporcao(params: {
    pesoFornecedor: number;
    pesoUpload: number;
  }): Promise<ConfiguracaoProporcaoDisparoSnapshot> {
    const atual = await this.prisma.configuracaoProporcaoDisparo.findFirst({ orderBy: { vigenteDesde: "asc" } });
    if (!atual) {
      const criada = await this.prisma.configuracaoProporcaoDisparo.create({
        data: { pesoFornecedor: params.pesoFornecedor, pesoUpload: params.pesoUpload },
      });
      return { pesoFornecedor: criada.pesoFornecedor, pesoUpload: criada.pesoUpload, vigenteDesde: criada.vigenteDesde };
    }
    // Salvar os MESMOS pesos de novo não reinicia a janela de contagem —
    // só muda vigenteDesde quando pelo menos um peso muda de verdade.
    if (atual.pesoFornecedor === params.pesoFornecedor && atual.pesoUpload === params.pesoUpload) {
      return { pesoFornecedor: atual.pesoFornecedor, pesoUpload: atual.pesoUpload, vigenteDesde: atual.vigenteDesde };
    }
    const atualizada = await this.prisma.configuracaoProporcaoDisparo.update({
      where: { id: atual.id },
      data: { pesoFornecedor: params.pesoFornecedor, pesoUpload: params.pesoUpload, vigenteDesde: new Date() },
    });
    return {
      pesoFornecedor: atualizada.pesoFornecedor,
      pesoUpload: atualizada.pesoUpload,
      vigenteDesde: atualizada.vigenteDesde,
    };
  }

  // Registra CADA tentativa do Disparo individual (worker8) — sucesso ou
  // falha — pra ficar visível na tela de detalhes da oferta. Antes disso só
  // existia como log de sistema (console), sem nenhum jeito de ver depois
  // sem entrar no log bruto do servidor.
  async registrarTentativaDisparoIndividual(dados: {
    offerId: string;
    endpointId: string;
    endpointUrl: string;
    modelo: string;
    sucesso: boolean;
    httpStatus: number | null;
    timeout: boolean;
    erro: string | null;
    payloadEnviado: unknown;
  }): Promise<void> {
    await this.prisma.disparoIndividualTentativa.create({
      data: {
        offerId: dados.offerId,
        endpointId: dados.endpointId,
        endpointUrl: dados.endpointUrl,
        modelo: dados.modelo,
        sucesso: dados.sucesso,
        httpStatus: dados.httpStatus,
        timeout: dados.timeout,
        erro: dados.erro,
        payloadEnviado: dados.payloadEnviado as Prisma.InputJsonValue,
      },
    });
  }

  async listarTentativasDisparoIndividual(offerId: string) {
    return this.prisma.disparoIndividualTentativa.findMany({
      where: { offerId },
      orderBy: { createdAt: "desc" },
    });
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
    // COALESCE: só preenche o marcador cumulativo na PRIMEIRA vez (nunca
    // sobrescreve um valor que já existe) — ver comentário no schema.prisma
    // sobre por que esses 2 campos existem separados do "status" atual.
    const marcadorSql =
      params.novoStatus === "DISPARO_ENVIADO"
        ? Prisma.sql`disparo_enviado_em = COALESCE(disparo_enviado_em, now())`
        : Prisma.sql`disparo_respondido_em = COALESCE(disparo_respondido_em, now())`;
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      UPDATE offers
      SET status = ${params.novoStatus}::"OfferStatus", updated_at = now(), ${marcadorSql}
      WHERE ${whereSql}
      RETURNING ${OFFER_COLUMNS_SQL}
    `;
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  async buscarOfertaMaisRecentePorTelefone(
    telefoneDigitos: string
  ): Promise<(OfferSnapshot & { origemWebhook: string | null }) | null> {
    // BUG REAL corrigido em 04/09 — telefoneValidado/telefoneAtualizado são
    // gravados SEM o DDI (confirmado repetidamente nessa mesma investigação:
    // formato cru, ex.: "62993929051", nunca "5562993929051"). A rota que
    // chama esse método costumava ADICIONAR o 55 antes de comparar — o que
    // fazia a busca nunca bater com o formato realmente gravado. Corrigido
    // testando os dois formatos possíveis (com e sem DDI), sem depender de
    // adivinhar qual está certo pra cada oferta.
    const comDDI = telefoneDigitos.length <= 11 ? `55${telefoneDigitos}` : telefoneDigitos;
    const semDDI = telefoneDigitos.startsWith("55") && telefoneDigitos.length >= 12
      ? telefoneDigitos.slice(2)
      : telefoneDigitos;

    // Não reaproveita OFFER_COLUMNS_SQL aqui (diferente de outras queries)
    // porque ele seleciona "id" sem prefixo de tabela — com o JOIN em
    // webhooks (que TAMBÉM tem uma coluna "id"), isso vira "coluna
    // ambígua" no Postgres. Por isso essa query lista as colunas na mão,
    // com "o." explícito. LEFT JOIN (não INNER) — mesmo se por algum
    // motivo a referência ao webhook estiver quebrada, a oferta ainda
    // aparece (só com origem null), em vez de sumir da busca inteira.
    const rows = await this.prisma.$queryRaw<(OfferRow & { origem_webhook: string | null })[]>`
      SELECT
        o.id, o.webhook_id AS "webhookId", o.external_id AS "externalId", o.nome, o.cpf,
        o.data_nascimento AS "dataNascimento",
        o.telefone_original AS "telefoneOriginal", o.telefone_atualizado AS "telefoneAtualizado",
        o.telefone_validado AS "telefoneValidado", o.possui_whatsapp AS "possuiWhatsapp",
        o.banco_autorizado AS "bancoAutorizado",
        o.produto, o.valor, o.parcelas, o.status::text AS status,
        o.routing_rule_id AS "routingRuleId", o.endpoint_id AS "endpointId",
        o.tentativas_telefone AS "tentativasTelefone", o.tentativas_whatsapp AS "tentativasWhatsapp",
        o.tentativas_envio AS "tentativasEnvio", o.reserved_at AS "reservedAt",
        o.whatsapp_request_id AS "whatsappRequestId", o.whatsapp_lote_id AS "whatsappLoteId",
        o.whatsapp_check_iniciado_em AS "whatsappCheckIniciadoEm",
        w.origem AS origem_webhook
      FROM offers o
      LEFT JOIN webhooks w ON w.id = o.webhook_id
      WHERE o.telefone_validado IN (${comDDI}, ${semDDI})
         OR o.telefone_atualizado IN (${comDDI}, ${semDDI})
      ORDER BY o.created_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return { ...mapRow(rows[0]), origemWebhook: rows[0].origem_webhook };
  }

  // -------------------------------------------------------------------------
  // Worker 0 — Consulta de margem Facta (04/09)
  // -------------------------------------------------------------------------

  async claimOffersParaMargem(limit: number, agora: Date): Promise<OfertaParaMargemSnapshot[]> {
    const rows = await this.prisma.$queryRaw<{ id: string; cpf: string | null; tentativas_margem_facta: number }[]>`
      UPDATE offers
      SET status = 'CONSULTANDO_MARGEM_FACTA'::"OfferStatus", reserved_at = ${agora}, updated_at = ${agora}
      WHERE id IN (
        SELECT id FROM offers
        WHERE status = 'RECEBIDO'::"OfferStatus"
          AND (proxima_tentativa_margem_em IS NULL OR proxima_tentativa_margem_em <= ${agora})
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, cpf, tentativas_margem_facta
    `;
    return rows.map((r) => ({ id: r.id, cpf: r.cpf, tentativasMargemFacta: r.tentativas_margem_facta }));
  }

  async marcarMargemAprovada(
    offerId: string,
    dados: { valorMargemDisponivel: number | null; dadosCompletos: unknown }
  ): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: "MARGEM_APROVADA",
        valorMargemDisponivelFacta: dados.valorMargemDisponivel,
        dadosFactaOffline: (dados.dadosCompletos ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
  }

  async marcarMargemNegativa(
    offerId: string,
    dados: { valorMargemDisponivel: number; dadosCompletos: unknown }
  ): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: "MARGEM_NEGATIVA",
        valorMargemDisponivelFacta: dados.valorMargemDisponivel,
        dadosFactaOffline: dados.dadosCompletos as Prisma.InputJsonValue,
      },
    });
  }

  async marcarAguardandoConsultaOnline(offerId: string, respostaBruta: unknown): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: { status: "AGUARDANDO_CONSULTA_ONLINE", dadosFactaOffline: respostaBruta as Prisma.InputJsonValue },
    });
  }

  async marcarErroMargem(
    offerId: string,
    params: { erro: string; tentativa: number; proximaTentativaEm: Date }
  ): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: "RECEBIDO",
        reservedAt: null,
        tentativasMargemFacta: params.tentativa,
        proximaTentativaMargemEm: params.proximaTentativaEm,
      },
    });
  }

  async buscarTokenFactaCache(): Promise<{ token: string; expiraEm: Date } | null> {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "FACTA_MARGEM_CREDENCIAIS" } });
    const valor = (config?.valor ?? {}) as { tokenCache?: string; tokenCacheExpiraEm?: string };
    if (!valor.tokenCache || !valor.tokenCacheExpiraEm) return null;
    return { token: valor.tokenCache, expiraEm: new Date(valor.tokenCacheExpiraEm) };
  }

  async salvarTokenFactaCache(token: string, expiraEm: Date): Promise<void> {
    const atual = await this.prisma.integrationConfig.findUnique({ where: { chave: "FACTA_MARGEM_CREDENCIAIS" } });
    const valorAtual = (atual?.valor ?? {}) as Record<string, unknown>;
    const novoValor = { ...valorAtual, tokenCache: token, tokenCacheExpiraEm: expiraEm.toISOString() };
    await this.prisma.integrationConfig.upsert({
      where: { chave: "FACTA_MARGEM_CREDENCIAIS" },
      create: { chave: "FACTA_MARGEM_CREDENCIAIS", ativo: false, valor: novoValor },
      update: { valor: novoValor },
    });
  }

  // -------------------------------------------------------------------------
  // Consulta ONLINE Facta (04/09, 2ª etapa)
  // -------------------------------------------------------------------------

  async claimOffersParaRegistrarAutorizacaoOnline(limit: number): Promise<OfertaParaOnlineFactaSnapshot[]> {
    const rows = await this.prisma.$queryRaw<
      { id: string; cpf: string | null; nome: string | null; telefone_original: string | null; tentativas_online_facta: number }[]
    >`
      UPDATE offers
      SET status = 'REGISTRANDO_AUTORIZACAO_ONLINE_FACTA'::"OfferStatus", reserved_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM offers
        WHERE status = 'AGUARDANDO_CONSULTA_ONLINE'::"OfferStatus"
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, cpf, nome, telefone_original, tentativas_online_facta
    `;
    return rows.map((r) => ({
      id: r.id,
      cpf: r.cpf,
      nome: r.nome,
      telefoneOriginal: r.telefone_original,
      tentativasOnlineFacta: r.tentativas_online_facta,
    }));
  }

  async marcarAutorizacaoOnlineRegistrada(offerId: string, respostaBruta: unknown, proximaVerificacaoEm: Date): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: "AGUARDANDO_RESULTADO_ONLINE_FACTA",
        dadosFactaOnline: toJsonInput(respostaBruta),
        proximaTentativaOnlineFactaEm: proximaVerificacaoEm,
        reservedAt: null,
      },
    });
  }

  async marcarErroRegistrarAutorizacaoOnline(
    offerId: string,
    params: { erro: string; tentativa: number; proximaTentativaEm: Date }
  ): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: "AGUARDANDO_CONSULTA_ONLINE",
        reservedAt: null,
        tentativasOnlineFacta: params.tentativa,
        proximaTentativaOnlineFactaEm: params.proximaTentativaEm,
      },
    });
  }

  async claimOffersParaVerificarResultadoOnline(limit: number, agora: Date): Promise<OfertaParaOnlineFactaSnapshot[]> {
    const rows = await this.prisma.$queryRaw<
      { id: string; cpf: string | null; nome: string | null; telefone_original: string | null; tentativas_online_facta: number }[]
    >`
      UPDATE offers
      SET status = 'CONSULTANDO_RESULTADO_ONLINE_FACTA'::"OfferStatus", reserved_at = ${agora}, updated_at = ${agora}
      WHERE id IN (
        SELECT id FROM offers
        WHERE status = 'AGUARDANDO_RESULTADO_ONLINE_FACTA'::"OfferStatus"
          AND (proxima_tentativa_online_facta_em IS NULL OR proxima_tentativa_online_facta_em <= ${agora})
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, cpf, nome, telefone_original, tentativas_online_facta
    `;
    return rows.map((r) => ({
      id: r.id,
      cpf: r.cpf,
      nome: r.nome,
      telefoneOriginal: r.telefone_original,
      tentativasOnlineFacta: r.tentativas_online_facta,
    }));
  }

  async marcarMargemAprovadaOnline(offerId: string, dados: { valorMargemDisponivel: number; dadosCompletos: unknown }): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: "MARGEM_APROVADA",
        valorMargemDisponivelFacta: dados.valorMargemDisponivel,
        dadosFactaOnline: toJsonInput(dados.dadosCompletos),
        reservedAt: null,
      },
    });
  }

  async marcarMargemNegativaOnline(offerId: string, dados: { valorMargemDisponivel: number; dadosCompletos: unknown }): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: "MARGEM_NEGATIVA",
        valorMargemDisponivelFacta: dados.valorMargemDisponivel,
        dadosFactaOnline: toJsonInput(dados.dadosCompletos),
        reservedAt: null,
      },
    });
  }

  async marcarAindaProcessandoOnline(offerId: string, proximaVerificacaoEm: Date, tentativa: number): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: "AGUARDANDO_RESULTADO_ONLINE_FACTA",
        reservedAt: null,
        tentativasOnlineFacta: tentativa,
        proximaTentativaOnlineFactaEm: proximaVerificacaoEm,
      },
    });
  }

  async marcarFalhaAbertaOnline(offerId: string): Promise<void> {
    await this.prisma.offer.update({
      where: { id: offerId },
      data: { status: "MARGEM_APROVADA", reservedAt: null },
    });
  }

  async buscarTokenOnlineFactaCache(): Promise<{ token: string; expiraEm: Date } | null> {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "FACTA_MARGEM_CREDENCIAIS" } });
    const valor = (config?.valor ?? {}) as { tokenCacheOnline?: string; tokenCacheOnlineExpiraEm?: string };
    if (!valor.tokenCacheOnline || !valor.tokenCacheOnlineExpiraEm) return null;
    return { token: valor.tokenCacheOnline, expiraEm: new Date(valor.tokenCacheOnlineExpiraEm) };
  }

  async salvarTokenOnlineFactaCache(token: string, expiraEm: Date): Promise<void> {
    const atual = await this.prisma.integrationConfig.findUnique({ where: { chave: "FACTA_MARGEM_CREDENCIAIS" } });
    const valorAtual = (atual?.valor ?? {}) as Record<string, unknown>;
    const novoValor = { ...valorAtual, tokenCacheOnline: token, tokenCacheOnlineExpiraEm: expiraEm.toISOString() };
    await this.prisma.integrationConfig.upsert({
      where: { chave: "FACTA_MARGEM_CREDENCIAIS" },
      create: { chave: "FACTA_MARGEM_CREDENCIAIS", ativo: false, valor: novoValor },
      update: { valor: novoValor },
    });
  }
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}
