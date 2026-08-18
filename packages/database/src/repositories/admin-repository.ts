import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { hashSenha, verificarSenha, gerarSenhaTemporaria, gerarTokenSessao } from "@plataforma-ofertas/shared";

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

  async dashboardSummary(params: { statuses?: string[] } = {}) {
    const where = params.statuses && params.statuses.length > 0 ? { status: { in: params.statuses as never[] } } : {};
    const rows = await this.prisma.offer.groupBy({ by: ["status"], where, _count: { _all: true } });
    const porStatus: Record<string, number> = {};
    for (const row of rows) {
      porStatus[row.status] = row._count._all;
    }
    const total = rows.reduce((sum, r) => sum + r._count._all, 0);
    return { total, porStatus };
  }

  // Cartões de KPI do topo do dashboard novo — 6 contagens específicas, com
  // filtro de período opcional (from/to, por created_at) e filtro opcional de
  // status (multi-seleção do dashboard — quando ativo, re-filtra TODOS os
  // cards, não só uma tabela auxiliar). "Limite validado" usa o nome legado
  // "Limit" = Lemit (ver worker1-limit.ts): consideramos validado quando a
  // Lemit devolveu algum dado de enriquecimento de verdade (data de
  // nascimento ou telefone próprio dela), não só quando a etapa foi apenas
  // pulada (Lemit desativada/sem CPF).
  //
  // Quando o filtro de status está ativo, cada card que já é baseado em
  // status específico (aguardandoProcessamento, aguardandoConsultaDisparo,
  // disparoConsultado) faz a INTERSEÇÃO entre seus status "naturais" e os
  // selecionados pelo usuário — ex.: se o usuário desmarcar
  // AGUARDANDO_DISPARO no filtro, esse card correspondente zera. Os cards que
  // não são baseados em status (totalRecebidas, limiteValidado,
  // whatsappValidado) só recebem o filtro como uma condição A MAIS (E lógico).
  async dashboardKpis(params: { from?: Date; to?: Date; statuses?: string[] }) {
    const createdAt =
      params.from || params.to
        ? { createdAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {};
    const filtroAtivo = params.statuses && params.statuses.length > 0 ? params.statuses : null;

    function intersecta(candidatos: string[]): string[] {
      if (!filtroAtivo) return candidatos;
      return candidatos.filter((c) => filtroAtivo!.includes(c));
    }

    const STATUS_PROCESSAMENTO = ["RECEBIDO", "PROCESSANDO_TELEFONE", "TELEFONE_ATUALIZADO", "VALIDANDO_WHATSAPP"];
    const filtroExtra = filtroAtivo ? { status: { in: filtroAtivo as never[] } } : {};

    const [
      totalRecebidas,
      aguardandoProcessamento,
      limiteValidado,
      whatsappValidado,
      aguardandoConsultaDisparo,
      disparoConsultado,
    ] = await Promise.all([
      this.prisma.offer.count({ where: { ...createdAt, ...filtroExtra } }),
      this.prisma.offer.count({ where: { ...createdAt, status: { in: intersecta(STATUS_PROCESSAMENTO) as never[] } } }),
      this.prisma.offer.count({
        where: {
          ...createdAt,
          OR: [{ dataNascimento: { not: null } }, { telefoneLemit: { not: null } }],
          ...filtroExtra,
        },
      }),
      this.prisma.offer.count({ where: { ...createdAt, possuiWhatsapp: true, ...filtroExtra } }),
      this.prisma.offer.count({ where: { ...createdAt, status: { in: intersecta(["AGUARDANDO_DISPARO"]) as never[] } } }),
      this.prisma.offer.count({ where: { ...createdAt, status: { in: intersecta(["DISPARO_CONSULTADO"]) as never[] } } }),
    ]);

    return {
      totalRecebidas,
      aguardandoProcessamento,
      limiteValidado,
      whatsappValidado,
      aguardandoConsultaDisparo,
      disparoConsultado,
      atualizadoEm: new Date().toISOString(),
    };
  }

  // Série temporal (gráfico de linha do dashboard novo) — volume recebido vs.
  // "processado" (chegou a algum resultado, bom ou ruim — não está mais nas
  // etapas iniciais) por dia, dentro do período filtrado. Sempre agrupa por
  // dia (não por hora) para manter simples independente do período escolhido.
  // statuses (opcional): mesmo filtro multi-seleção do dashboard — quando
  // ativo, só conta ofertas cujo status está na lista selecionada.
  async dashboardTimeseries(params: { from?: Date; to?: Date; statuses?: string[] }) {
    const from = params.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = params.to ?? new Date();
    const filtroStatus =
      params.statuses && params.statuses.length > 0
        ? Prisma.sql`AND status IN (${Prisma.join(params.statuses)})`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<{ dia: Date; recebidas: bigint; processadas: bigint }[]>(
      Prisma.sql`
        SELECT
          date_trunc('day', created_at) AS dia,
          count(*) AS recebidas,
          count(*) FILTER (
            WHERE status NOT IN ('RECEBIDO', 'PROCESSANDO_TELEFONE', 'TELEFONE_ATUALIZADO', 'VALIDANDO_WHATSAPP')
          ) AS processadas
        FROM offers
        WHERE created_at >= ${from} AND created_at <= ${to} ${filtroStatus}
        GROUP BY dia
        ORDER BY dia ASC
      `
    );

    return rows.map((r) => ({
      dia: r.dia.toISOString().slice(0, 10),
      recebidas: Number(r.recebidas),
      processadas: Number(r.processadas),
    }));
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

  async listOffers(params: { status?: string; cpf?: string; limit: number; offset: number }) {
    // Busca por CPF: parcial (contains), ignorando pontuação que o usuário
    // possa ter digitado (a coluna cpf é salva só com dígitos).
    const cpfDigits = params.cpf ? params.cpf.replace(/\D/g, "") : "";
    const where = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(cpfDigits ? { cpf: { contains: cpfDigits } } : {}),
    };
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

  // -- Usuários do painel / autenticação -------------------------------------------
  // Login individual (antes só existia o token compartilhado ADMIN_API_TOKEN).
  // Sessão por token opaco em vez de JWT — mais simples de revogar (só apagar a
  // linha), adequado pro volume baixo de um painel interno.

  private semSenha<T extends { senhaHash: string }>(user: T): Omit<T, "senhaHash"> {
    const { senhaHash: _senhaHash, ...resto } = user;
    return resto;
  }

  async listarUsuarios() {
    const usuarios = await this.prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });
    return usuarios.map((u) => this.semSenha(u));
  }

  async criarUsuario(params: { nome: string; email: string; senha: string; role: "ADMINISTRADOR" | "OPERADOR" | "VISUALIZADOR" }) {
    const senhaHash = await hashSenha(params.senha);
    const usuario = await this.prisma.adminUser.create({
      data: { nome: params.nome, email: params.email.toLowerCase().trim(), senhaHash, role: params.role },
    });
    return this.semSenha(usuario);
  }

  async atualizarUsuario(
    id: string,
    params: { nome?: string; email?: string; role?: "ADMINISTRADOR" | "OPERADOR" | "VISUALIZADOR"; ativo?: boolean }
  ) {
    const usuario = await this.prisma.adminUser.update({
      where: { id },
      data: {
        ...(params.nome !== undefined ? { nome: params.nome } : {}),
        ...(params.email !== undefined ? { email: params.email.toLowerCase().trim() } : {}),
        ...(params.role !== undefined ? { role: params.role } : {}),
        ...(params.ativo !== undefined ? { ativo: params.ativo } : {}),
      },
    });
    // Desativou o usuário? Derruba as sessões ativas dele na hora, em vez de
    // esperar expirar sozinha.
    if (params.ativo === false) {
      await this.prisma.adminSession.deleteMany({ where: { userId: id } });
    }
    return this.semSenha(usuario);
  }

  // Gera uma senha temporária nova e devolve em texto puro (só nesse momento —
  // nunca mais fica recuperável depois, só o hash fica salvo). Usado pelo botão
  // "Gerar senha nova" no painel.
  async gerarNovaSenhaUsuario(id: string): Promise<string> {
    const senhaTemporaria = gerarSenhaTemporaria();
    const senhaHash = await hashSenha(senhaTemporaria);
    await this.prisma.adminUser.update({ where: { id }, data: { senhaHash } });
    // Qualquer sessão ativa continua valendo (trocar senha não derruba sessão
    // já aberta) — só a próxima tentativa de login usa a senha nova.
    return senhaTemporaria;
  }

  async verificarLogin(email: string, senha: string) {
    const usuario = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!usuario || !usuario.ativo) return null;
    const senhaCorreta = await verificarSenha(senha, usuario.senhaHash);
    if (!senhaCorreta) return null;
    await this.prisma.adminUser.update({ where: { id: usuario.id }, data: { ultimoAcesso: new Date() } });
    return this.semSenha(usuario);
  }

  async criarSessao(userId: string, duracaoMs = 12 * 60 * 60 * 1000): Promise<string> {
    const token = gerarTokenSessao();
    await this.prisma.adminSession.create({
      data: { token, userId, expiresAt: new Date(Date.now() + duracaoMs) },
    });
    return token;
  }

  async validarSessao(token: string) {
    const sessao = await this.prisma.adminSession.findUnique({ where: { token }, include: { user: true } });
    if (!sessao) return null;
    if (sessao.expiresAt.getTime() < Date.now()) {
      await this.prisma.adminSession.delete({ where: { id: sessao.id } }).catch(() => {});
      return null;
    }
    if (!sessao.user.ativo) return null;
    return this.semSenha(sessao.user);
  }

  async encerrarSessao(token: string): Promise<void> {
    await this.prisma.adminSession.deleteMany({ where: { token } });
  }

  // Chamado uma vez na inicialização do servidor: se ainda não existe nenhum
  // usuário, cria o primeiro admin a partir de variáveis de ambiente — sem
  // isso, ninguém conseguiria logar num sistema novo (é o único jeito de
  // "plantar a primeira semente" de um sistema que agora exige login).
  async garantirAdminInicial(params: { nome: string; email: string; senha: string }): Promise<boolean> {
    const existeAlguem = (await this.prisma.adminUser.count()) > 0;
    if (existeAlguem) return false;
    await this.criarUsuario({ nome: params.nome, email: params.email, senha: params.senha, role: "ADMINISTRADOR" });
    return true;
  }
}
