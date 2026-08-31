import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { hashSenha, verificarSenha, gerarSenhaTemporaria, gerarTokenSessao } from "@plataforma-ofertas/shared";

// Nunca devolve a credencial em texto puro pro painel — só se está configurada e os
// últimos 4 caracteres, pra confirmar visualmente que é a chave certa sem expor o resto.
function mascararCredencial(valor: unknown): {
  apiKeyConfigurada: boolean;
  apiKeyMascarada: string | null;
  baseUrl: string | null;
  intervaloSegundos: number | null;
  limiteRequisicoesPorCiclo: number | null;
  loteMinimo: number | null;
  loteMaximo: number | null;
  tempoMaximoEsperaLoteMinutos: number | null;
} {
  const v = (valor ?? {}) as {
    apiKey?: string;
    baseUrl?: string;
    intervaloSegundos?: number;
    limiteRequisicoesPorCiclo?: number;
    loteMinimo?: number;
    loteMaximo?: number;
    tempoMaximoEsperaLoteMinutos?: number;
  };
  const apiKey = v.apiKey ?? null;
  return {
    apiKeyConfigurada: Boolean(apiKey),
    apiKeyMascarada: apiKey ? `${"•".repeat(Math.max(apiKey.length - 4, 0))}${apiKey.slice(-4)}` : null,
    baseUrl: v.baseUrl ?? null,
    intervaloSegundos: typeof v.intervaloSegundos === "number" && v.intervaloSegundos > 0 ? v.intervaloSegundos : null,
    limiteRequisicoesPorCiclo:
      typeof v.limiteRequisicoesPorCiclo === "number" && v.limiteRequisicoesPorCiclo > 0 ? v.limiteRequisicoesPorCiclo : null,
    loteMinimo: typeof v.loteMinimo === "number" && v.loteMinimo > 0 ? v.loteMinimo : null,
    loteMaximo: typeof v.loteMaximo === "number" && v.loteMaximo > 0 ? v.loteMaximo : null,
    tempoMaximoEsperaLoteMinutos:
      typeof v.tempoMaximoEsperaLoteMinutos === "number" && v.tempoMaximoEsperaLoteMinutos > 0 ? v.tempoMaximoEsperaLoteMinutos : null,
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
  // Cards de KPI + comparativo com o período anterior de igual duração (item
  // "delta ▲/▼ vs. período anterior" do redesign do Dashboard) — só calcula o
  // "anterior" quando o usuário filtrou um intervalo FECHADO (from E to); num
  // período aberto ("todo o histórico") não existe um "anterior" bem
  // definido, então fica null e o front-end simplesmente não mostra o selo de
  // variação nesse caso.
  // Diagnóstico SÓ LEITURA: pra responder "se validou WhatsApp, deveria ter
  // sido disparado — por que os números não fecham?". Mostra, pra QUALQUER
  // oferta com possuiWhatsapp=true, em qual status ela está PARADA agora —
  // revela na hora se tem gente presa em algum lugar inesperado (ex.: ainda
  // em WHATSAPP_VALIDADO sem nunca ter avançado, ou travada num status de
  // roteamento antigo), em vez de estar espalhada nos status esperados do
  // funil de disparo (AGUARDANDO_DISPARO, DISPARO_CONSULTADO, etc.).
  async diagnosticoWhatsappValidadoPorStatus() {
    const rows = await this.prisma.offer.groupBy({
      by: ["status"],
      where: { possuiWhatsapp: true },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ status: r.status, total: r._count._all }))
      .sort((a, b) => b.total - a.total);
  }

  async dashboardKpis(params: { from?: Date; to?: Date; statuses?: string[] }) {
    const atual = await this.contarKpis(params);

    let anterior: Awaited<ReturnType<AdminRepository["contarKpis"]>> | null = null;
    if (params.from && params.to) {
      const duracaoMs = params.to.getTime() - params.from.getTime();
      const toAnterior = params.from;
      const fromAnterior = new Date(params.from.getTime() - duracaoMs);
      anterior = await this.contarKpis({ from: fromAnterior, to: toAnterior, statuses: params.statuses });
    }

    return {
      ...atual,
      anterior,
      atualizadoEm: new Date().toISOString(),
    };
  }

  private async contarKpis(params: { from?: Date; to?: Date; statuses?: string[] }) {
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
      disparoEnviado,
      disparoRespondido,
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
      this.prisma.offer.count({
        where: {
          ...(params.from || params.to
            ? { disparoEnviadoEm: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
            : { disparoEnviadoEm: { not: null } }),
        },
      }),
      this.prisma.offer.count({
        where: {
          ...(params.from || params.to
            ? { disparoRespondidoEm: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
            : { disparoRespondidoEm: { not: null } }),
        },
      }),
    ]);

    return {
      totalRecebidas,
      aguardandoProcessamento,
      limiteValidado,
      whatsappValidado,
      aguardandoConsultaDisparo,
      disparoConsultado,
      disparoEnviado,
      disparoRespondido,
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

  // Série temporal comparativa "Disparo Enviado x Disparo Respondido" (pro
  // gráfico do Dashboard) — usa os marcadores cumulativos (disparo_enviado_em
  // / disparo_respondido_em), não o "status" atual, então uma oferta que já
  // foi respondida continua contando no dia em que foi ENVIADA também (são
  // dias possivelmente diferentes — union pelos 2 lados, não um só GROUP BY).
  async dashboardEnviadosVsRespondidos(params: { from?: Date; to?: Date }) {
    const from = params.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = params.to ?? new Date();

    const rows = await this.prisma.$queryRaw<{ dia: Date; enviados: bigint; respondidos: bigint }[]>(
      Prisma.sql`
        WITH enviados AS (
          SELECT date_trunc('day', disparo_enviado_em) AS dia, count(*) AS total
          FROM offers
          WHERE disparo_enviado_em >= ${from} AND disparo_enviado_em <= ${to}
          GROUP BY dia
        ),
        respondidos AS (
          SELECT date_trunc('day', disparo_respondido_em) AS dia, count(*) AS total
          FROM offers
          WHERE disparo_respondido_em >= ${from} AND disparo_respondido_em <= ${to}
          GROUP BY dia
        )
        SELECT
          COALESCE(e.dia, r.dia) AS dia,
          COALESCE(e.total, 0) AS enviados,
          COALESCE(r.total, 0) AS respondidos
        FROM enviados e
        FULL OUTER JOIN respondidos r ON e.dia = r.dia
        ORDER BY dia ASC
      `
    );

    return rows.map((r) => ({
      dia: r.dia.toISOString().slice(0, 10),
      enviados: Number(r.enviados),
      respondidos: Number(r.respondidos),
    }));
  }

  // Série temporal "Ofertas recebidas x Disparos enviados" (Gráfico 1 do
  // redesign do Dashboard) — mesma técnica de dashboardEnviadosVsRespondidos
  // (2 CTEs + FULL OUTER JOIN por dia), só troca o lado "respondidos" por
  // "recebidas" (created_at). Responde uma pergunta diferente do gráfico
  // "recebidas x processadas" de dashboardTimeseries: aqui é especificamente
  // sobre o gargalo de conversão até o disparo, não sobre qualquer saída das
  // etapas iniciais (boa ou ruim).
  async dashboardRecebidasVsEnviados(params: { from?: Date; to?: Date }) {
    const from = params.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = params.to ?? new Date();

    const rows = await this.prisma.$queryRaw<{ dia: Date; recebidas: bigint; enviados: bigint }[]>(
      Prisma.sql`
        WITH recebidas AS (
          SELECT date_trunc('day', created_at) AS dia, count(*) AS total
          FROM offers
          WHERE created_at >= ${from} AND created_at <= ${to}
          GROUP BY dia
        ),
        enviados AS (
          SELECT date_trunc('day', disparo_enviado_em) AS dia, count(*) AS total
          FROM offers
          WHERE disparo_enviado_em >= ${from} AND disparo_enviado_em <= ${to}
          GROUP BY dia
        )
        SELECT
          COALESCE(r.dia, e.dia) AS dia,
          COALESCE(r.total, 0) AS recebidas,
          COALESCE(e.total, 0) AS enviados
        FROM recebidas r
        FULL OUTER JOIN enviados e ON r.dia = e.dia
        ORDER BY dia ASC
      `
    );

    return rows.map((r) => ({
      dia: r.dia.toISOString().slice(0, 10),
      recebidas: Number(r.recebidas),
      enviados: Number(r.enviados),
    }));
  }

  // Volume de respostas por hora do dia (0h-23h) — cruzamento de dados do
  // redesign do Dashboard ("horário com maior taxa de resposta"), pra ajudar
  // a operação a concentrar reforços/retentativas de disparo na janela de
  // pico. Preenche as 24 horas mesmo sem nenhuma resposta registrada nelas,
  // pra o gráfico de barras não "pular" horas no eixo X.
  //
  // "disparo_respondido_em" é uma coluna `timestamp` (SEM timezone) que guarda
  // o instante em UTC (é o que o Prisma/Node grava) — um EXTRACT(HOUR FROM ...)
  // direto nela lê a hora literal gravada, ou seja, a hora em UTC, não em
  // Brasília (mesmo bug de fuso já corrigido no painel, agora encontrado aqui
  // na consulta: um pico às 18h de Brasília aparecia como 21h). Por isso
  // convertemos explicitamente pra America/Sao_Paulo antes do EXTRACT — 1º
  // "AT TIME ZONE 'UTC'" reinterpreta o valor gravado como o instante UTC que
  // ele já é (vira timestamptz), 2º "AT TIME ZONE 'America/Sao_Paulo'" projeta
  // esse instante no horário de parede de Brasília.
  async dashboardHorarioResposta(params: { from?: Date; to?: Date } = {}) {
    const desde = params.from ? Prisma.sql`AND disparo_respondido_em >= ${params.from}` : Prisma.empty;
    const ate = params.to ? Prisma.sql`AND disparo_respondido_em <= ${params.to}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<{ hora: number; total: bigint }[]>(
      Prisma.sql`
        SELECT
          EXTRACT(HOUR FROM (disparo_respondido_em AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo'))::int AS hora,
          count(*) AS total
        FROM offers
        WHERE disparo_respondido_em IS NOT NULL ${desde} ${ate}
        GROUP BY hora
        ORDER BY hora ASC
      `
    );

    const porHora = new Map(rows.map((r) => [Number(r.hora), Number(r.total)]));
    return Array.from({ length: 24 }, (_, hora) => ({ hora, total: porHora.get(hora) ?? 0 }));
  }

  // Tempo médio (em segundos) entre duas etapas do funil — só sobre ofertas
  // que JÁ concluíram a etapa seguinte (não distorce com casos ainda em
  // andamento). Duas médias separadas de propósito, porque apontam para
  // responsáveis diferentes: a primeira mede a demora do PIPELINE interno
  // (Lemit + validação de WhatsApp em lote); a segunda mede a velocidade de
  // resposta do LEAD depois de receber o disparo.
  async dashboardTempoMedioEtapas(params: { from?: Date; to?: Date } = {}) {
    const desdeEnviado = params.from ? Prisma.sql`AND disparo_enviado_em >= ${params.from}` : Prisma.empty;
    const ateEnviado = params.to ? Prisma.sql`AND disparo_enviado_em <= ${params.to}` : Prisma.empty;
    const desdeRespondido = params.from ? Prisma.sql`AND disparo_respondido_em >= ${params.from}` : Prisma.empty;
    const ateRespondido = params.to ? Prisma.sql`AND disparo_respondido_em <= ${params.to}` : Prisma.empty;

    const [recebidoParaEnviado, enviadoParaRespondido] = await Promise.all([
      this.prisma.$queryRaw<{ media_segundos: number | null }[]>(
        Prisma.sql`
          SELECT AVG(EXTRACT(EPOCH FROM (disparo_enviado_em - created_at))) AS media_segundos
          FROM offers
          WHERE disparo_enviado_em IS NOT NULL ${desdeEnviado} ${ateEnviado}
        `
      ),
      this.prisma.$queryRaw<{ media_segundos: number | null }[]>(
        Prisma.sql`
          SELECT AVG(EXTRACT(EPOCH FROM (disparo_respondido_em - disparo_enviado_em))) AS media_segundos
          FROM offers
          WHERE disparo_respondido_em IS NOT NULL ${desdeRespondido} ${ateRespondido}
        `
      ),
    ]);

    return {
      recebimentoParaDisparoSegundos: recebidoParaEnviado[0]?.media_segundos ?? null,
      disparoParaRespostaSegundos: enviadoParaRespondido[0]?.media_segundos ?? null,
    };
  }

  // Taxa de resposta por parceiro/origem (webhook) — cruzamento de dados do
  // redesign do Dashboard. Deliberadamente NÃO reaproveita dashboardPorWebhook
  // (abaixo): aquele método agrupa pelo status ATUAL da oferta, que
  // subcontaria "enviados" sempre que uma oferta já avançou para
  // DISPARO_RESPONDIDO (só um status pode ser o atual por vez — o mesmo
  // motivo pelo qual dashboardEnviadosVsRespondidos usa os marcadores
  // cumulativos em vez de "status"). Aqui usamos os mesmos marcadores
  // cumulativos, agora quebrados por parceiro.
  async dashboardTaxaRespostaPorWebhook(params: { from?: Date; to?: Date } = {}) {
    const desde = params.from ? Prisma.sql`AND o.created_at >= ${params.from}` : Prisma.empty;
    const ate = params.to ? Prisma.sql`AND o.created_at <= ${params.to}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      { webhook_id: string; identificador: string; origem: string; recebidas: bigint; enviados: bigint; respondidos: bigint }[]
    >(
      Prisma.sql`
        SELECT
          w.id AS webhook_id,
          w.identificador,
          w.origem,
          count(*) AS recebidas,
          count(*) FILTER (WHERE o.disparo_enviado_em IS NOT NULL) AS enviados,
          count(*) FILTER (WHERE o.disparo_respondido_em IS NOT NULL) AS respondidos
        FROM offers o
        JOIN webhooks w ON w.id = o.webhook_id
        WHERE true ${desde} ${ate}
        GROUP BY w.id, w.identificador, w.origem
        ORDER BY recebidas DESC
      `
    );

    return rows.map((r) => {
      const enviados = Number(r.enviados);
      const respondidos = Number(r.respondidos);
      return {
        webhookId: r.webhook_id,
        identificador: r.identificador,
        origem: r.origem,
        recebidas: Number(r.recebidas),
        enviados,
        respondidos,
        taxaResposta: enviados > 0 ? respondidos / enviados : null,
      };
    });
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
    dados: {
      apiKey?: string;
      baseUrl?: string;
      intervaloSegundos?: number;
      limiteRequisicoesPorCiclo?: number;
      loteMinimo?: number;
      loteMaximo?: number;
      tempoMaximoEsperaLoteMinutos?: number;
    }
  ) {
    const atual = await this.prisma.integrationConfig.findUnique({ where: { chave } });
    const valorAtual = (atual?.valor ?? {}) as {
      apiKey?: string;
      baseUrl?: string;
      intervaloSegundos?: number;
      limiteRequisicoesPorCiclo?: number;
      loteMinimo?: number;
      loteMaximo?: number;
      tempoMaximoEsperaLoteMinutos?: number;
    };
    const apiKey =
      dados.apiKey !== undefined && dados.apiKey.trim() !== "" ? dados.apiKey.trim() : valorAtual.apiKey ?? null;
    const baseUrl =
      dados.baseUrl !== undefined ? (dados.baseUrl.trim() === "" ? null : dados.baseUrl.trim()) : valorAtual.baseUrl ?? null;
    // Só troca o intervalo se vier um número válido e positivo — mesma lógica
    // "em branco = mantém o que já estava" das outras credenciais.
    const intervaloSegundos =
      dados.intervaloSegundos !== undefined && Number.isFinite(dados.intervaloSegundos) && dados.intervaloSegundos > 0
        ? Math.floor(dados.intervaloSegundos)
        : valorAtual.intervaloSegundos ?? null;
    // Mesma lógica pro limite de requisições por ciclo (rate limit da API
    // externa) — usado pelo worker pra nunca processar mais que isso num
    // único ciclo (ver resolverBatchSize em apps/workers/src/index.ts).
    const limiteRequisicoesPorCiclo =
      dados.limiteRequisicoesPorCiclo !== undefined &&
      Number.isFinite(dados.limiteRequisicoesPorCiclo) &&
      dados.limiteRequisicoesPorCiclo > 0
        ? Math.floor(dados.limiteRequisicoesPorCiclo)
        : valorAtual.limiteRequisicoesPorCiclo ?? null;
    // Parâmetros do lote de validação de WhatsApp (checknumber.ai) — só faz
    // sentido pra WHATSAPP_VALIDACAO_CREDENCIAIS, mas não custa aceitar o
    // campo pra Lemit também (fica simplesmente sem uso lá).
    const loteMinimo =
      dados.loteMinimo !== undefined && Number.isFinite(dados.loteMinimo) && dados.loteMinimo > 0
        ? Math.floor(dados.loteMinimo)
        : valorAtual.loteMinimo ?? null;
    const loteMaximo =
      dados.loteMaximo !== undefined && Number.isFinite(dados.loteMaximo) && dados.loteMaximo > 0
        ? Math.floor(dados.loteMaximo)
        : valorAtual.loteMaximo ?? null;
    const tempoMaximoEsperaLoteMinutos =
      dados.tempoMaximoEsperaLoteMinutos !== undefined &&
      Number.isFinite(dados.tempoMaximoEsperaLoteMinutos) &&
      dados.tempoMaximoEsperaLoteMinutos > 0
        ? Math.floor(dados.tempoMaximoEsperaLoteMinutos)
        : valorAtual.tempoMaximoEsperaLoteMinutos ?? null;
    const novoValor = {
      apiKey,
      baseUrl,
      intervaloSegundos,
      limiteRequisicoesPorCiclo,
      loteMinimo,
      loteMaximo,
      tempoMaximoEsperaLoteMinutos,
    };
    return this.prisma.integrationConfig.upsert({
      where: { chave },
      update: { valor: novoValor },
      create: { chave, valor: novoValor, ativo: true },
    });
  }

  // -- Relatório periódico (nova integração — envia os KPIs do dia por POST pro
  // endpoint cadastrado aqui pelo usuário, na frequência configurada) -----------
  // Mesmo padrão das credenciais acima: uma chave própria em "integration_configs",
  // { endpointUrl, intervaloHoras, horaInicio, horaFim } dentro de "valor", "ativo"
  // no campo já existente da tabela. O worker (apps/workers/src/index.ts) lê essa
  // config a cada ciclo. "horaInicio"/"horaFim" ("HH:MM", horário de Brasília) são a
  // janela em que o envio é permitido (ex.: "08:00"/"20:00" pra não mandar de
  // madrugada) — em branco os dois, o worker envia a qualquer hora.

  async getRelatorioPeriodicoConfig() {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "RELATORIO_PERIODICO_WEBHOOK" } });
    const valor = (config?.valor ?? {}) as {
      endpointUrl?: string;
      intervaloHoras?: number;
      horaInicio?: string;
      horaFim?: string;
    };
    return {
      ativo: config?.ativo ?? false,
      endpointUrl: valor.endpointUrl ?? null,
      intervaloHoras: typeof valor.intervaloHoras === "number" && valor.intervaloHoras > 0 ? valor.intervaloHoras : null,
      horaInicio: valor.horaInicio ?? null,
      horaFim: valor.horaFim ?? null,
    };
  }

  async salvarRelatorioPeriodicoConfig(dados: {
    ativo?: boolean;
    endpointUrl?: string;
    intervaloHoras?: number;
    horaInicio?: string;
    horaFim?: string;
  }) {
    const HORA_MINUTO_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
    const atual = await this.prisma.integrationConfig.findUnique({ where: { chave: "RELATORIO_PERIODICO_WEBHOOK" } });
    const valorAtual = (atual?.valor ?? {}) as {
      endpointUrl?: string;
      intervaloHoras?: number;
      horaInicio?: string;
      horaFim?: string;
    };
    const endpointUrl =
      dados.endpointUrl !== undefined
        ? dados.endpointUrl.trim() === ""
          ? null
          : dados.endpointUrl.trim()
        : valorAtual.endpointUrl ?? null;
    const intervaloHoras =
      dados.intervaloHoras !== undefined && Number.isFinite(dados.intervaloHoras) && dados.intervaloHoras > 0
        ? Math.floor(dados.intervaloHoras)
        : valorAtual.intervaloHoras ?? null;
    // Campo em branco = mantém o que já estava (mesma convenção dos outros
    // campos acima); valor inválido (não é "HH:MM") também mantém o anterior,
    // em vez de salvar uma janela quebrada que travaria o envio pra sempre.
    const horaInicio =
      dados.horaInicio !== undefined
        ? dados.horaInicio.trim() === ""
          ? null
          : HORA_MINUTO_REGEX.test(dados.horaInicio.trim())
            ? dados.horaInicio.trim()
            : valorAtual.horaInicio ?? null
        : valorAtual.horaInicio ?? null;
    const horaFim =
      dados.horaFim !== undefined
        ? dados.horaFim.trim() === ""
          ? null
          : HORA_MINUTO_REGEX.test(dados.horaFim.trim())
            ? dados.horaFim.trim()
            : valorAtual.horaFim ?? null
        : valorAtual.horaFim ?? null;
    const novoValor = { endpointUrl, intervaloHoras, horaInicio, horaFim };
    const ativo = dados.ativo ?? atual?.ativo ?? false;
    return this.prisma.integrationConfig.upsert({
      where: { chave: "RELATORIO_PERIODICO_WEBHOOK" },
      update: { valor: novoValor, ativo },
      create: { chave: "RELATORIO_PERIODICO_WEBHOOK", valor: novoValor, ativo },
    });
  }

  // Disparo individual (push, 1 lead por ciclo) — mesmo padrão de
  // armazenamento do relatório periódico, chave própria.
  async getDisparoIndividualConfig() {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "DISPARO_INDIVIDUAL_WEBHOOK" } });
    const valor = (config?.valor ?? {}) as {
      endpointUrl?: string;
      endpoints?: Array<{ id: string; url: string; ativo: boolean; modelo?: "hyperflow" | "ararahq" }>;
      intervaloSegundos?: number;
      ararahqApiKey?: string;
    };
    // Migração automática, em 2 camadas, só na leitura:
    // 1) formato bem antigo (1 endpoint só) vira lista;
    // 2) qualquer endpoint sem "modelo" definido (formato de antes desse
    //    campo existir) vira "hyperflow" — era o único formato que existia.
    let endpointsBrutos = valor.endpoints;
    if ((!endpointsBrutos || endpointsBrutos.length === 0) && valor.endpointUrl) {
      endpointsBrutos = [{ id: "migrado-automatico", url: valor.endpointUrl, ativo: true }];
    }
    const endpoints = (endpointsBrutos ?? []).map((e) => ({
      id: e.id,
      url: e.url,
      ativo: e.ativo,
      modelo: e.modelo === "ararahq" ? ("ararahq" as const) : ("hyperflow" as const),
    }));
    const apiKey = valor.ararahqApiKey ?? null;
    return {
      ativo: config?.ativo ?? false,
      endpoints,
      intervaloSegundos:
        typeof valor.intervaloSegundos === "number" && valor.intervaloSegundos > 0 ? valor.intervaloSegundos : null,
      // Mesmo padrão de mascaramento da Lemit/WhatsApp — nunca devolve a
      // chave em texto puro pro painel, só confirma que está configurada e
      // os últimos 4 caracteres.
      ararahqApiKeyConfigurada: Boolean(apiKey),
      ararahqApiKeyMascarada: apiKey ? `${"•".repeat(Math.max(apiKey.length - 4, 0))}${apiKey.slice(-4)}` : null,
    };
  }

  async salvarDisparoIndividualConfig(dados: {
    ativo?: boolean;
    endpoints?: { id: string; url: string; ativo: boolean; modelo?: "hyperflow" | "ararahq" }[];
    intervaloSegundos?: number;
    ararahqApiKey?: string;
  }) {
    const atual = await this.prisma.integrationConfig.findUnique({ where: { chave: "DISPARO_INDIVIDUAL_WEBHOOK" } });
    const valorAtual = (atual?.valor ?? {}) as {
      endpointUrl?: string;
      endpoints?: { id: string; url: string; ativo: boolean; modelo?: "hyperflow" | "ararahq" }[];
      intervaloSegundos?: number;
      ararahqApiKey?: string;
    };
    // A lista inteira é substituída de uma vez (a tela manda o estado atual
    // completo a cada "Salvar", não uma alteração incremental) — filtra
    // linhas com URL vazia (descartadas antes de chegar aqui, mas por
    // segurança), garante um id em cada uma, e "hyperflow" como modelo
    // padrão se não vier nenhum.
    const endpoints =
      dados.endpoints !== undefined
        ? dados.endpoints
            .map((e, i) => ({
              id: e.id || `endpoint-${Date.now()}-${i}`,
              url: (e.url || "").trim(),
              ativo: !!e.ativo,
              modelo: e.modelo === "ararahq" ? ("ararahq" as const) : ("hyperflow" as const),
            }))
            .filter((e) => e.url !== "")
        : (valorAtual.endpoints ?? (valorAtual.endpointUrl ? [{ id: "migrado-automatico", url: valorAtual.endpointUrl, ativo: true, modelo: "hyperflow" as const }] : []));
    const intervaloSegundos =
      dados.intervaloSegundos !== undefined && Number.isFinite(dados.intervaloSegundos) && dados.intervaloSegundos > 0
        ? Math.floor(dados.intervaloSegundos)
        : valorAtual.intervaloSegundos ?? null;
    // Mesma lógica "em branco = mantém a atual" da Lemit/WhatsApp — uma
    // chave só, compartilhada por todos os endpoints Ararahq (confirmado
    // com o cliente, não é por endpoint).
    const ararahqApiKey =
      dados.ararahqApiKey !== undefined && dados.ararahqApiKey.trim() !== ""
        ? dados.ararahqApiKey.trim()
        : valorAtual.ararahqApiKey ?? null;
    const novoValor = { endpoints, intervaloSegundos, ararahqApiKey };
    const ativo = dados.ativo ?? atual?.ativo ?? false;
    return this.prisma.integrationConfig.upsert({
      where: { chave: "DISPARO_INDIVIDUAL_WEBHOOK" },
      update: { valor: novoValor, ativo },
      create: { chave: "DISPARO_INDIVIDUAL_WEBHOOK", valor: novoValor, ativo },
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

  // -- Relatórios / exportação (módulo /relatorios) ---------------------------------
  // Sem paginação de propósito (é pra baixar tudo que bate com o filtro, não
  // pra navegar página a página) — aceita múltiplos status (diferente de
  // listOffers, que só aceita um) e período por created_at, igual o
  // dashboard. Uso interno/baixo volume, então uma consulta sem LIMIT é
  // aceitável aqui.
  async listOffersParaRelatorio(params: { statuses?: string[]; from?: Date; to?: Date }) {
    const where = {
      ...(params.statuses && params.statuses.length > 0 ? { status: { in: params.statuses as never[] } } : {}),
      ...(params.from || params.to
        ? { createdAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
    };
    return this.prisma.offer.findMany({ where, orderBy: { createdAt: "desc" } });
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
    const [processingEvents, dispatches, phoneValidations, disparoIndividualTentativas] = await Promise.all([
      this.prisma.offerProcessing.findMany({ where: { offerId }, orderBy: { createdAt: "asc" } }),
      this.prisma.dispatch.findMany({ where: { offerId }, orderBy: { createdAt: "asc" } }),
      this.prisma.phoneValidation.findMany({ where: { offerId }, orderBy: { createdAt: "asc" } }),
      // Disparo individual (worker8) — diferente de "dispatches" acima, que
      // é do mecanismo de roteamento mais antigo (RoutingRule/Endpoint).
      this.prisma.disparoIndividualTentativa.findMany({ where: { offerId }, orderBy: { createdAt: "asc" } }),
    ]);
    return { offer, processingEvents, dispatches, phoneValidations, disparoIndividualTentativas };
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
