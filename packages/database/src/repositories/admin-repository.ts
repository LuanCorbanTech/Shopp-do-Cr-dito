import type { PrismaClient } from "@prisma/client";

// Nunca devolve a credencial em texto puro pro painel — só se está configurada e os
// últimos 4 caracteres, pra confirmar visualmente que é a chave certa sem expor o resto.
function mascararCredencial(valor: unknown): {
  apiKeyConfigurada: boolean;
  apiKeyMascarada: string | null;
  baseUrl: string | null;
} {
  const v = (valor ?? {}) as { apiKey?: string; baseUrl?: string };
  const apiKey = v.apiKey ?? null;
  return {
    apiKeyConfigurada: Boolean(apiKey),
    apiKeyMascarada: apiKey ? `${"•".repeat(Math.max(apiKey.length - 4, 0))}${apiKey.slice(-4)}` : null,
    baseUrl: v.baseUrl ?? null,
  };
}

// Consultas usadas pela API administrativa (seção 31-38 do escopo original / seção 8
// do doc de arquitetura). Ao contrário dos workers, aqui vamos direto ao Prisma sem
// uma porta/interface adicional — é código de leitura/CRUD simples, e o ganho de
// testabilidade da abstração extra não compensa a duplicação neste caso.
export class AdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async dashboardSummary() {
    const rows = await this.prisma.offer.groupBy({ by: ["status"], _count: { _all: true } });
    const porStatus: Record<string, number> = {};
    for (const row of rows) {
      porStatus[row.status] = row._count._all;
    }
    const total = rows.reduce((sum, r) => sum + r._count._all, 0);
    return { total, porStatus };
  }

  async dashboardPorWebhook() {
    const webhooks = await this.prisma.webhook.findMany();
    const results = [];
    for (const webhook of webhooks) {
      const rows = await this.prisma.offer.groupBy({
        by: ["status"],
        where: { webhookId: webhook.id },
        _count: { _all: true },
      });
      const porStatus: Record<string, number> = {};
      for (const row of rows) porStatus[row.status] = row._count._all;
      results.push({ webhook: { id: webhook.id, identificador: webhook.identificador, origem: webhook.origem }, porStatus });
    }
    return results;
  }

  async dashboardPorBanco() {
    const rows = await this.prisma.offer.groupBy({
      by: ["bancoAutorizado", "status"],
      _count: { _all: true },
    });
    const porBanco: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      const banco = row.bancoAutorizado ?? "(não informado)";
      porBanco[banco] ??= {};
      porBanco[banco][row.status] = row._count._all;
    }
    return porBanco;
  }

  async dashboardPorEndpoint() {
    const endpoints = await this.prisma.endpoint.findMany();
    const results = [];
    for (const endpoint of endpoints) {
      const [enviados, falhas, retries, fila] = await Promise.all([
        this.prisma.dispatch.count({ where: { endpointId: endpoint.id, status: "SUCESSO" } }),
        this.prisma.dispatch.count({ where: { endpointId: endpoint.id, status: "FALHA" } }),
        this.prisma.dispatch.count({ where: { endpointId: endpoint.id, status: "RETRYING" } }),
        this.prisma.offer.count({ where: { endpointId: endpoint.id, status: "AGUARDANDO_ENVIO" } }),
      ]);
      const totalTentativas = enviados + falhas;
      results.push({
        endpoint,
        enviados,
        falhas,
        retries,
        filaPendente: fila,
        taxaSucesso: totalTentativas > 0 ? enviados / totalTentativas : null,
      });
    }
    return results;
  }

  // -- Integração Limit (toggle dinâmico, item 32) --------------------------------

  async getLimitConfig() {
    return this.prisma.integrationConfig.findUnique({ where: { chave: "LIMIT_CONSULTA" } });
  }

  async setLimitEnabled(ativo: boolean) {
    return this.prisma.integrationConfig.upsert({
      where: { chave: "LIMIT_CONSULTA" },
      update: { ativo },
      create: { chave: "LIMIT_CONSULTA", ativo, valor: {} },
    });
  }

  async limitStats() {
    const [processados, erros, ultima] = await Promise.all([
      this.prisma.offerProcessing.count({ where: { etapa: "LIMIT", resultado: "SUCESSO" } }),
      this.prisma.offerProcessing.count({ where: { etapa: "LIMIT", resultado: "FALHA" } }),
      this.prisma.offerProcessing.findFirst({ where: { etapa: "LIMIT" }, orderBy: { createdAt: "desc" } }),
    ]);
    return { processados, erros, ultimaExecucao: ultima?.createdAt ?? null };
  }

  // -- Credenciais Lemit / CorbanTech WhatsApp (editáveis no painel, sem precisar
  // tocar no servidor) ---------------------------------------------------------
  // Reaproveita a mesma tabela "integration_configs" do toggle do Limit — cada
  // credencial vira uma chave própria com { apiKey, baseUrl } dentro de "valor".
  // Os workers leem essa tabela a cada ciclo (packages/workers/src/index.ts), então
  // uma troca aqui vale no próximo ciclo do worker, sem reiniciar nada.

  async getCredenciaisIntegracoes() {
    const [lemit, whatsapp] = await Promise.all([
      this.prisma.integrationConfig.findUnique({ where: { chave: "LEMIT_CREDENCIAIS" } }),
      this.prisma.integrationConfig.findUnique({ where: { chave: "WHATSAPP_VALIDACAO_CREDENCIAIS" } }),
    ]);
    return {
      lemit: mascararCredencial(lemit?.valor),
      whatsapp: mascararCredencial(whatsapp?.valor),
    };
  }

  async salvarCredenciaisIntegracao(
    chave: "LEMIT_CREDENCIAIS" | "WHATSAPP_VALIDACAO_CREDENCIAIS",
    dados: { apiKey?: string; baseUrl?: string }
  ) {
    const atual = await this.prisma.integrationConfig.findUnique({ where: { chave } });
    const valorAtual = (atual?.valor ?? {}) as { apiKey?: string; baseUrl?: string };
    const apiKey =
      dados.apiKey !== undefined && dados.apiKey.trim() !== "" ? dados.apiKey.trim() : valorAtual.apiKey ?? null;
    const baseUrl =
      dados.baseUrl !== undefined ? (dados.baseUrl.trim() === "" ? null : dados.baseUrl.trim()) : valorAtual.baseUrl ?? null;
    const novoValor = { apiKey, baseUrl };
    return this.prisma.integrationConfig.upsert({
      where: { chave },
      update: { valor: novoValor },
      create: { chave, valor: novoValor, ativo: true },
    });
  }

  // -- Endpoints (item 19) ---------------------------------------------------------

  // -- Parceiros (webhooks de entrada) -----------------------------------------

  listWebhooks() {
    return this.prisma.webhook.findMany({ orderBy: { origem: "asc" } });
  }

  createWebhook(data: Parameters<PrismaClient["webhook"]["create"]>[0]["data"]) {
    return this.prisma.webhook.create({ data });
  }

  updateWebhook(id: string, data: Parameters<PrismaClient["webhook"]["update"]>[0]["data"]) {
    return this.prisma.webhook.update({ where: { id }, data });
  }

  // Quantidade de leads já recebidos por esse parceiro — usado pra decidir se dá
  // pra excluir de verdade (0 leads) ou se só dá pra desativar (tem histórico).
  countOffersForWebhook(webhookId: string) {
    return this.prisma.offer.count({ where: { webhookId } });
  }

  deleteWebhook(id: string) {
    return this.prisma.webhook.delete({ where: { id } });
  }

  listEndpoints() {
    return this.prisma.endpoint.findMany({ orderBy: { nome: "asc" } });
  }

  createEndpoint(data: Parameters<PrismaClient["endpoint"]["create"]>[0]["data"]) {
    return this.prisma.endpoint.create({ data });
  }

  updateEndpoint(id: string, data: Parameters<PrismaClient["endpoint"]["update"]>[0]["data"]) {
    return this.prisma.endpoint.update({ where: { id }, data });
  }

  // -- Regras de roteamento (itens 15-17) -------------------------------------------

  listRoutingRules() {
    return this.prisma.routingRule.findMany({ orderBy: { prioridade: "asc" }, include: { endpoint: true } });
  }

  createRoutingRule(data: Parameters<PrismaClient["routingRule"]["create"]>[0]["data"]) {
    return this.prisma.routingRule.create({ data });
  }

  updateRoutingRule(id: string, data: Parameters<PrismaClient["routingRule"]["update"]>[0]["data"]) {
    return this.prisma.routingRule.update({ where: { id }, data });
  }

  // -- Ofertas / timeline (item 38) -------------------------------------------------

  async listOffers(params: { status?: string; limit: number; offset: number }) {
    const where = params.status ? { status: params.status as never } : {};
    const [items, total] = await Promise.all([
      this.prisma.offer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: params.limit,
        skip: params.offset,
      }),
      this.prisma.offer.count({ where }),
    ]);
    return { items, total };
  }

  async getOfferTimeline(offerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { webhook: true, endpoint: true, routingRule: true },
    });
    if (!offer) return null;
    const [processingEvents, dispatches, phoneValidations] = await Promise.all([
      this.prisma.offerProcessing.findMany({ where: { offerId }, orderBy: { createdAt: "asc" } }),
      this.prisma.dispatch.findMany({ where: { offerId }, orderBy: { createdAt: "asc" } }),
      this.prisma.phoneValidation.findMany({ where: { offerId }, orderBy: { createdAt: "asc" } }),
    ]);
    return { offer, processingEvents, dispatches, phoneValidations };
  }
}
