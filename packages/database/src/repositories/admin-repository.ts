import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { hashSenha, verificarSenha, gerarSenhaTemporaria, gerarTokenSessao } from "@plataforma-ofertas/shared";
import { avaliarPioraQualidade } from "@plataforma-ofertas/domain";

// Nunca devolve a credencial em texto puro pro painel — só se está configurada e os
// últimos 4 caracteres, pra confirmar visualmente que é a chave certa sem expor o resto.
function mascararCredencial(valor: unknown): {
  apiKeyConfigurada: boolean;
  apiKeyMascarada: string | null;
  baseUrl: string | null;
  urlConsulta: string | null;
  intervaloSegundos: number | null;
  limiteRequisicoesPorCiclo: number | null;
  loteMinimo: number | null;
  loteMaximo: number | null;
  tempoMaximoEsperaLoteMinutos: number | null;
} {
  const v = (valor ?? {}) as {
    apiKey?: string;
    baseUrl?: string;
    urlConsulta?: string;
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
    // Não é segredo (é só um endereço), então aparece em texto puro na tela
    // — diferente da apiKey, que só mostra os últimos 4 caracteres.
    urlConsulta: v.urlConsulta ?? null,
    intervaloSegundos: typeof v.intervaloSegundos === "number" && v.intervaloSegundos > 0 ? v.intervaloSegundos : null,
    limiteRequisicoesPorCiclo:
      typeof v.limiteRequisicoesPorCiclo === "number" && v.limiteRequisicoesPorCiclo > 0 ? v.limiteRequisicoesPorCiclo : null,
    loteMinimo: typeof v.loteMinimo === "number" && v.loteMinimo > 0 ? v.loteMinimo : null,
    loteMaximo: typeof v.loteMaximo === "number" && v.loteMaximo > 0 ? v.loteMaximo : null,
    tempoMaximoEsperaLoteMinutos:
      typeof v.tempoMaximoEsperaLoteMinutos === "number" && v.tempoMaximoEsperaLoteMinutos > 0 ? v.tempoMaximoEsperaLoteMinutos : null,
  };
}

// Facta usa usuário+senha (Basic Auth), diferente da Lemit/CorbanTech (uma
// única "apiKey") — por isso uma função de mascaramento própria, em vez de
// forçar o mesmo formato da mascararCredencial acima. "usuario" não é
// segredo (aparece em texto puro); só "senha" é mascarada.
function mascararCredencialFacta(valor: unknown): {
  usuario: string | null;
  senhaConfigurada: boolean;
  senhaMascarada: string | null;
} {
  const v = (valor ?? {}) as { usuario?: string; senha?: string };
  const senha = v.senha ?? null;
  return {
    usuario: v.usuario ?? null,
    senhaConfigurada: Boolean(senha),
    senhaMascarada: senha ? `${"•".repeat(Math.max(senha.length - 3, 0))}${senha.slice(-3)}` : null,
  };
}

// Token do system user do app da BM (Qualidade WhatsApp, 10/09) — mesmo
// espírito das outras funções de mascarar acima: só os últimos 4 caracteres,
// nunca o valor completo de volta pro painel.
function mascararTokenBm(token: string | null | undefined): { tokenConfigurado: boolean; tokenMascarado: string | null } {
  if (!token) return { tokenConfigurado: false, tokenMascarado: null };
  return { tokenConfigurado: true, tokenMascarado: `${"•".repeat(Math.max(token.length - 4, 0))}${token.slice(-4)}` };
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
  // disparoConsultado — esse último considera DISPARO_CONSULTADO e também
  // os status seguintes do funil, DISPARO_ENVIADO/DISPARO_RESPONDIDO, já
  // que quem chegou até ali "passou" por consultado mesmo tendo avançado —
  // ver STATUS_CONSULTADO_OU_ALEM abaixo) faz a INTERSEÇÃO entre seus
  // status "naturais" e os selecionados pelo usuário — ex.: se o usuário
  // desmarcar AGUARDANDO_DISPARO no filtro, esse card correspondente zera.
  // Os cards que não são baseados em status (totalRecebidas, limiteValidado,
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

  // Diagnóstico SÓ LEITURA (03/09) — responde "por que 'Com Lemit validado'
  // está maior que 'Com WhatsApp validado', com a Lemit desativada?".
  // "Lemit validado" conta quem tem dataNascimento OU telefoneLemit
  // preenchidos — campos que SÓ são escritos numa consulta de verdade à
  // Lemit (nunca no recebimento do webhook em si, mesmo pra parceiros que
  // já mandam esses dados no payload deles). Com a Lemit desativada, a
  // ÚNICA forma de consultar de verdade é a "segunda chance" (worker1,
  // 02/09) — pra ofertas que ficaram SEM_WHATSAPP com o telefone original.
  //
  // IMPORTANTE: filtra pela data da CONSULTA em si (phone_validations.
  // created_at), não pela data da oferta — sem isso, o número soma junto
  // consultas bem antigas, de quando a Lemit podia estar ATIVADA (fluxo
  // normal, nada a ver com a segunda chance), misturando os dois cenários
  // e inflando o total sem revelar o efeito real da mudança nova.

  // ---------------------------------------------------------------------
  // Reprocessagem do bug do DDI no lote (03/09) — pra ofertas que ficaram
  // SEM_WHATSAPP incorretamente por causa da comparação sem DDI (ver
  // worker2-whatsapp.ts, comentário no topo). Busca de novo (SÓ LEITURA na
  // CorbanTech — sem gastar crédito de novo, a CorbanTech guarda os
  // resultados por 14 dias) o resultado do MESMO lote já pago, aplica a
  // comparação CORRIGIDA (com DDI), e corrige quem realmente tinha
  // WhatsApp e tinha sido classificado errado.
  private normalizarComDDIParaReprocessar(telefone: string): string {
    const digits = telefone.replace(/\D/g, "");
    if (digits.length >= 12 && digits.startsWith("55")) return digits;
    return `55${digits}`;
  }

  async reprocessarLotesDDI(webhookIdentificador: string): Promise<{
    lotesEncontrados: number;
    lotesComErro: string[];
    ofertasVerificadas: number;
    ofertasCorrigidas: number;
    ofertasContinuamSemWhatsapp: number;
  }> {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "WHATSAPP_VALIDACAO_CREDENCIAIS" } });
    const valorConfig = (config?.valor ?? {}) as { apiKey?: string; baseUrl?: string };
    const corbanApiKey = valorConfig.apiKey;
    const corbanBaseUrl = valorConfig.baseUrl || "http://localhost:9902";
    if (!corbanApiKey) throw new Error("Credenciais da CorbanTech não configuradas (painel Integrações).");

    const webhook = await this.prisma.webhook.findUnique({ where: { identificador: webhookIdentificador } });
    if (!webhook) throw new Error(`Webhook "${webhookIdentificador}" não encontrado.`);

    const ofertasAfetadas = await this.prisma.offer.findMany({
      where: { webhookId: webhook.id, status: "SEM_WHATSAPP", whatsappLoteId: { not: null } },
      select: { id: true, telefoneAtualizado: true, telefoneOriginal: true, whatsappLoteId: true },
    });

    const loteIds = [...new Set(ofertasAfetadas.map((o) => o.whatsappLoteId as string))];
    const lotesComErro: string[] = [];
    let ofertasVerificadas = 0;
    let ofertasCorrigidas = 0;
    let ofertasContinuamSemWhatsapp = 0;

    for (const loteId of loteIds) {
      try {
        const resposta = await fetch(
          `${corbanBaseUrl.replace(/\/$/, "")}/api/v1/whatsapp/check-lote/${encodeURIComponent(loteId)}`,
          { method: "GET", headers: { "X-API-Key": corbanApiKey } }
        );
        if (!resposta.ok) {
          lotesComErro.push(`${loteId} (HTTP ${resposta.status} — provavelmente expirou, a CorbanTech só guarda 14 dias)`);
          continue;
        }
        const body = (await resposta.json()) as { status: string; resultados?: { telefone: string; possui_whatsapp: boolean }[] };
        if (body.status !== "done" || !body.resultados) {
          lotesComErro.push(`${loteId} (status "${body.status}", sem resultados prontos)`);
          continue;
        }

        const porTelefone = new Map(body.resultados.map((r) => [r.telefone, r.possui_whatsapp]));
        const ofertasDesseLote = ofertasAfetadas.filter((o) => o.whatsappLoteId === loteId);

        for (const oferta of ofertasDesseLote) {
          ofertasVerificadas += 1;
          const telefoneUsado = (oferta.telefoneAtualizado ?? oferta.telefoneOriginal) as string;
          const possuiWhatsappCorrigido = porTelefone.get(this.normalizarComDDIParaReprocessar(telefoneUsado)) ?? false;

          if (possuiWhatsappCorrigido) {
            await this.prisma.offer.update({
              where: { id: oferta.id },
              data: { status: "AGUARDANDO_DISPARO", possuiWhatsapp: true, telefoneValidado: telefoneUsado },
            });
            ofertasCorrigidas += 1;
          } else {
            ofertasContinuamSemWhatsapp += 1;
          }
        }
      } catch (error) {
        lotesComErro.push(`${loteId} (erro: ${error instanceof Error ? error.message : String(error)})`);
      }
    }

    return {
      lotesEncontrados: loteIds.length,
      lotesComErro,
      ofertasVerificadas,
      ofertasCorrigidas,
      ofertasContinuamSemWhatsapp,
    };
  }

  // Diagnóstico SÓ LEITURA (03/09) — responde "até ontem batia certo, então
  // esse bug do DDI é novo ou só ficou visível agora?". Mostra, por
  // webhook (parceiro), a distribuição do TAMANHO do telefone usado nas
  // ofertas que passaram pelo caminho de LOTE — se os parceiros antigos
  // sempre mandaram telefone JÁ com DDI (13 dígitos) e só esse novo (o de
  // leilão) manda sem (11 dígitos), isso explica por que só agora o bug
  // virou um problema visível: por coincidência de formato, a comparação
  // batia certo antes, não porque a lógica estivesse certa.
  async diagnosticoTamanhoTelefonePorWebhook() {
    const rows = await this.prisma.$queryRaw<{ webhookId: string; origem: string; tamanho: number; total: bigint }[]>`
      SELECT o.webhook_id AS "webhookId", w.origem, LENGTH(REGEXP_REPLACE(COALESCE(o.telefone_atualizado, o.telefone_original), '\D', '', 'g')) AS tamanho, count(*) AS total
      FROM offers o
      JOIN webhooks w ON w.id = o.webhook_id
      WHERE o.whatsapp_lote_id IS NOT NULL
      GROUP BY o.webhook_id, w.origem, tamanho
      ORDER BY w.origem, tamanho
    `;
    return rows.map((r) => ({ webhookId: r.webhookId, origem: r.origem, tamanho: r.tamanho, total: Number(r.total) }));
  }

  async diagnosticoLemitVsWhatsapp(desde: Date) {
    const [
      lemitTotal,
      lemitComWhatsapp,
      lemitSemWhatsapp,
      whatsappSemLemitNoPeriodo,
    ] = await Promise.all([
      this.prisma.phoneValidation.count({
        where: { limitAtivoNoMomento: true, createdAt: { gte: desde } },
      }),
      this.prisma.phoneValidation.count({
        where: { limitAtivoNoMomento: true, createdAt: { gte: desde }, offer: { possuiWhatsapp: true } },
      }),
      this.prisma.phoneValidation.count({
        where: { limitAtivoNoMomento: true, createdAt: { gte: desde }, offer: { possuiWhatsapp: { not: true } } },
      }),
      this.prisma.offer.count({
        where: { possuiWhatsapp: true, dataNascimento: null, telefoneLemit: null, createdAt: { gte: desde } },
      }),
    ]);
    return { desde, lemitTotal, lemitComWhatsapp, lemitSemWhatsapp, whatsappSemLemitNoPeriodo };
  }

  async diagnosticoLemitVsWhatsappTudo() {
    const [
      lemitTotal,
      lemitComWhatsapp,
      lemitSemWhatsapp,
      whatsappSemLemit,
    ] = await Promise.all([
      this.prisma.offer.count({ where: { OR: [{ dataNascimento: { not: null } }, { telefoneLemit: { not: null } }] } }),
      this.prisma.offer.count({
        where: { OR: [{ dataNascimento: { not: null } }, { telefoneLemit: { not: null } }], possuiWhatsapp: true },
      }),
      this.prisma.offer.count({
        where: { OR: [{ dataNascimento: { not: null } }, { telefoneLemit: { not: null } }], possuiWhatsapp: { not: true } },
      }),
      this.prisma.offer.count({
        where: { possuiWhatsapp: true, dataNascimento: null, telefoneLemit: null },
      }),
    ]);
    return { lemitTotal, lemitComWhatsapp, lemitSemWhatsapp, whatsappSemLemit };
  }

  // ---------------------------------------------------------------------
  // Tarefas de recebimento (liga/desliga fornecedor numa data/hora
  // marcada, até bater uma meta de ofertas) — CRUD pro painel + métodos
  // que o worker9-tarefas usa pra decidir o que fazer a cada ciclo.
  // ---------------------------------------------------------------------

  async listarTarefas() {
    return this.prisma.tarefa.findMany({
      include: { webhook: { select: { id: true, identificador: true, origem: true } } },
      orderBy: { dataHoraExecucao: "desc" },
    });
  }

  async criarTarefa(dados: {
    nome: string;
    fornecedor: string;
    webhookId: string;
    dataHoraExecucao: Date;
    quantidadeOfertas: number;
  }) {
    return this.prisma.tarefa.create({ data: dados });
  }

  async cancelarTarefa(id: string) {
    // Só cancela se ainda estiver PENDENTE — não faz sentido "cancelar" uma
    // que já está rodando ou já terminou (pra isso, tem os botões de
    // pausar/tentar de novo, ou desligar manualmente na tela do fornecedor).
    const tarefa = await this.prisma.tarefa.findUnique({ where: { id } });
    if (!tarefa || tarefa.status !== "PENDENTE") return null;
    return this.prisma.tarefa.update({ where: { id }, data: { status: "CANCELADA" } });
  }

  // ---- Ações do usuário na tela (efeito IMEDIATO no status, o efeito
  // real no fornecedor — ligar/desligar de verdade — acontece no próximo
  // ciclo do worker9, que é quem tem a lógica de chamar a API externa).

  async retentarTarefa(id: string) {
    // Só faz sentido pra quem está em ERRO — volta pra PENDENTE, o worker
    // pega ela nas próximas ~30s (a data/hora marcada já passou, então
    // conta como vencida de novo).
    const tarefa = await this.prisma.tarefa.findUnique({ where: { id } });
    if (!tarefa || tarefa.status !== "ERRO") return null;
    return this.prisma.tarefa.update({ where: { id }, data: { status: "PENDENTE", erro: null } });
  }

  async solicitarPausa(id: string) {
    // Só pra quem está RODANDO — o worker confirma no próximo ciclo
    // (desliga o fornecedor de verdade e só então marca PAUSADA).
    const tarefa = await this.prisma.tarefa.findUnique({ where: { id } });
    if (!tarefa || tarefa.status !== "RODANDO") return null;
    return this.prisma.tarefa.update({ where: { id }, data: { status: "PAUSANDO" } });
  }

  async solicitarReativacao(id: string) {
    // Só pra quem está PAUSADA — o worker confirma no próximo ciclo (liga
    // o fornecedor de novo e só então marca RODANDO, sem resetar a
    // contagem já feita).
    const tarefa = await this.prisma.tarefa.findUnique({ where: { id } });
    if (!tarefa || tarefa.status !== "PAUSADA") return null;
    return this.prisma.tarefa.update({ where: { id }, data: { status: "REATIVANDO" } });
  }

  // ---- Métodos usados pelo worker9-tarefas (via TarefaPort) ----

  async listarWebhooksComTarefasAtivas(): Promise<string[]> {
    const rows = await this.prisma.tarefa.findMany({
      where: { status: { in: ["PENDENTE", "RODANDO", "PAUSADA", "PAUSANDO", "REATIVANDO"] } },
      select: { webhookId: true },
      distinct: ["webhookId"],
    });
    return rows.map((r) => r.webhookId);
  }

  async buscarTarefaOcupante(webhookId: string) {
    const t = await this.prisma.tarefa.findFirst({
      where: { webhookId, status: { in: ["RODANDO", "PAUSADA", "PAUSANDO", "REATIVANDO"] } },
    });
    if (!t) return null;
    return {
      id: t.id,
      nome: t.nome,
      fornecedor: t.fornecedor,
      webhookId: t.webhookId,
      quantidadeOfertas: t.quantidadeOfertas,
      iniciadoEm: t.iniciadoEm,
      status: t.status as "RODANDO" | "PAUSADA" | "PAUSANDO" | "REATIVANDO",
    };
  }

  async buscarProximaTarefaPendente(webhookId: string, agora: Date) {
    const t = await this.prisma.tarefa.findFirst({
      where: { webhookId, status: "PENDENTE", dataHoraExecucao: { lte: agora } },
      orderBy: { dataHoraExecucao: "asc" },
    });
    if (!t) return null;
    return {
      id: t.id,
      nome: t.nome,
      fornecedor: t.fornecedor,
      webhookId: t.webhookId,
      quantidadeOfertas: t.quantidadeOfertas,
    };
  }

  async contarOfertasDesde(webhookId: string, desde: Date): Promise<number> {
    return this.prisma.offer.count({ where: { webhookId, createdAt: { gte: desde } } });
  }

  async marcarTarefaRodando(id: string, iniciadoEm: Date): Promise<void> {
    await this.prisma.tarefa.update({ where: { id }, data: { status: "RODANDO", iniciadoEm, erro: null } });
  }

  async marcarTarefaConcluida(id: string, ofertasRecebidas: number, concluidoEm: Date): Promise<void> {
    await this.prisma.tarefa.update({
      where: { id },
      data: { status: "CONCLUIDA", ofertasRecebidas, concluidoEm, erro: null },
    });
  }

  async marcarTarefaErro(id: string, erro: string): Promise<void> {
    await this.prisma.tarefa.update({ where: { id }, data: { status: "ERRO", erro } });
  }

  async marcarTarefaPausada(id: string): Promise<void> {
    await this.prisma.tarefa.update({ where: { id }, data: { status: "PAUSADA", erro: null } });
  }

  async marcarTarefaReativada(id: string): Promise<void> {
    // Não mexe em iniciadoEm — a contagem de ofertas continua de onde já
    // estava, não reinicia do zero.
    await this.prisma.tarefa.update({ where: { id }, data: { status: "RODANDO", erro: null } });
  }

  // ---- Chave de API por fornecedor (hoje só Odysseia) — mesmo padrão de
  // mascaramento da Lemit/WhatsApp/Ararahq. Aparece na tela de Integrações
  // (não na de Tarefas, que só CONSOME essa chave via worker9). ----

  async getOdysseiaConfig() {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "ODYSSEIA_API_KEY" } });
    const valor = (config?.valor ?? {}) as { apiKey?: string };
    const apiKey = valor.apiKey ?? null;
    return {
      apiKeyConfigurada: Boolean(apiKey),
      apiKeyMascarada: apiKey ? `${"•".repeat(Math.max(apiKey.length - 4, 0))}${apiKey.slice(-4)}` : null,
    };
  }

  async salvarOdysseiaApiKey(apiKey: string): Promise<void> {
    if (!apiKey || apiKey.trim() === "") return; // "em branco" = mantém a atual, mesmo padrão dos outros
    await this.prisma.integrationConfig.upsert({
      where: { chave: "ODYSSEIA_API_KEY" },
      update: { valor: { apiKey: apiKey.trim() }, ativo: true },
      create: { chave: "ODYSSEIA_API_KEY", valor: { apiKey: apiKey.trim() }, ativo: true },
    });
  }

  async buscarApiKeyFornecedor(fornecedor: string): Promise<string | null> {
    if (fornecedor !== "odysseia") return null; // só esse suportado por enquanto
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "ODYSSEIA_API_KEY" } });
    const valor = (config?.valor ?? {}) as { apiKey?: string };
    return valor.apiKey ?? null;
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
    // "Consultado" precisa contar quem CHEGOU a esse status, não só quem
    // está exatamente nele agora — o pipeline anda rápido, uma oferta pode
    // avançar de "consultado" pra "enviado"/"respondido" quase na hora, e
    // antes isso fazia o card cair artificialmente mesmo sem nenhum
    // problema real (mesma filosofia cumulativa que "enviado"/"respondido"
    // já usam, ver disparoEnviadoEm/disparoRespondidoEm abaixo — só que
    // esses 2 têm coluna de data própria, e "consultado" não tem, então a
    // forma de tornar cumulativo aqui é incluir os status seguintes do
    // funil na mesma contagem).
    const STATUS_CONSULTADO_OU_ALEM = ["DISPARO_CONSULTADO", "DISPARO_ENVIADO", "DISPARO_RESPONDIDO"];
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
      factaOfflineAprovada,
      factaOfflineNegativa,
      factaOnlineAprovada,
      factaOnlineNegativa,
      factaAguardandoOnline,
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
      this.prisma.offer.count({ where: { ...createdAt, status: { in: intersecta(STATUS_CONSULTADO_OU_ALEM) as never[] } } }),
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
      // Consulta de margem Facta (04/09) — separado por etapa (offline vs
      // online) e por resultado (aprovada vs negativa). "Offline" = decidiu
      // já na 1ª consulta (dadosFactaOnline ainda nulo); "Online" = precisou
      // da 2ª etapa (dadosFactaOnline preenchido — mesmo que dadosFactaOffline
      // também esteja preenchido, com a resposta "nenhum dado encontrado" da
      // 1ª tentativa).
      this.prisma.offer.count({
        where: { ...createdAt, status: "MARGEM_APROVADA", dadosFactaOffline: { not: Prisma.DbNull }, dadosFactaOnline: { equals: Prisma.DbNull } },
      }),
      this.prisma.offer.count({
        where: { ...createdAt, status: "MARGEM_NEGATIVA", dadosFactaOffline: { not: Prisma.DbNull }, dadosFactaOnline: { equals: Prisma.DbNull } },
      }),
      this.prisma.offer.count({
        where: { ...createdAt, status: "MARGEM_APROVADA", dadosFactaOnline: { not: Prisma.DbNull } },
      }),
      this.prisma.offer.count({
        where: { ...createdAt, status: "MARGEM_NEGATIVA", dadosFactaOnline: { not: Prisma.DbNull } },
      }),
      this.prisma.offer.count({
        where: {
          ...createdAt,
          status: {
            in: intersecta([
              "AGUARDANDO_CONSULTA_ONLINE",
              "REGISTRANDO_AUTORIZACAO_ONLINE_FACTA",
              "AGUARDANDO_RESULTADO_ONLINE_FACTA",
              "CONSULTANDO_RESULTADO_ONLINE_FACTA",
            ]) as never[],
          },
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
      factaOfflineAprovada,
      factaOfflineNegativa,
      factaOnlineAprovada,
      factaOnlineNegativa,
      factaAguardandoOnline,
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

  // Consulta de margem Facta (04/09) — credencial própria (usuario+senha),
  // separada das de cima por ter formato diferente (Basic Auth, não uma
  // apiKey única).
  async getCredenciaisFacta() {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "FACTA_MARGEM_CREDENCIAIS" } });
    return { ...mascararCredencialFacta(config?.valor), ativo: config?.ativo ?? false };
  }

  async salvarCredenciaisFacta(dados: { usuario?: string; senha?: string; ativo: boolean }) {
    const atual = await this.prisma.integrationConfig.findUnique({ where: { chave: "FACTA_MARGEM_CREDENCIAIS" } });
    const valorAtual = (atual?.valor ?? {}) as Record<string, unknown>;
    const usuario = dados.usuario !== undefined && dados.usuario.trim() !== "" ? dados.usuario.trim() : valorAtual.usuario ?? null;
    const senha = dados.senha !== undefined && dados.senha.trim() !== "" ? dados.senha.trim() : valorAtual.senha ?? null;
    // Preserva o cache do token (tokenCache/tokenCacheExpiraEm) já salvo pelo
    // worker — trocar usuario/senha aqui não deve apagar um token ainda
    // válido à toa (o worker mesmo detecta e gera um novo se a credencial
    // mudou e o token antigo passar a falhar).
    const novoValor = { ...valorAtual, usuario, senha };
    await this.prisma.integrationConfig.upsert({
      where: { chave: "FACTA_MARGEM_CREDENCIAIS" },
      create: { chave: "FACTA_MARGEM_CREDENCIAIS", ativo: dados.ativo, valor: novoValor },
      update: { ativo: dados.ativo, valor: novoValor },
    });
    return this.getCredenciaisFacta();
  }

  // Ferramenta de teste (04/09) — consulta 1 CPF na Facta usando a credencial
  // já salva, SEM tocar em nenhuma oferta (não é o worker, é só um "ping"
  // manual). Sem homologação disponível, esse é o jeito seguro de validar a
  // integração em produção antes de ligar o worker automático pra valer.
  // Não reaproveita cache de token daqui (chamada rara, sem custo relevante
  // gerar um token novo a cada teste manual).
  async testarConsultaFacta(cpfBruto: string): Promise<{
    tokenGerado: boolean;
    cpfConsultado: string;
    dados: Record<string, unknown> | null;
    mensagem: string;
  }> {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "FACTA_MARGEM_CREDENCIAIS" } });
    const valor = (config?.valor ?? {}) as { usuario?: string; senha?: string; baseUrl?: string };
    if (!valor.usuario || !valor.senha) {
      throw new Error("Credenciais da Facta não configuradas ainda (usuario/senha) — salve antes de testar.");
    }
    const baseUrl = (valor.baseUrl || "https://cltoff.facta.com.br").replace(/\/$/, "");
    const cpfLimpo = cpfBruto.replace(/\D/g, "");

    const basic = Buffer.from(`${valor.usuario}:${valor.senha}`).toString("base64");
    const respostaToken = await fetch(`${baseUrl}/gera-token`, { method: "GET", headers: { Authorization: `Basic ${basic}` } });
    const corpoToken = (await respostaToken.json().catch(() => null)) as { erro?: boolean; mensagem?: string; token?: string } | null;
    if (!respostaToken.ok || !corpoToken || corpoToken.erro || !corpoToken.token) {
      throw new Error(corpoToken?.mensagem || `Facta respondeu ${respostaToken.status} ao gerar token`);
    }

    const respostaConsulta = await fetch(`${baseUrl}/clt/base-offline?cpf=${cpfLimpo}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${corpoToken.token}` },
    });
    const corpoConsulta = (await respostaConsulta.json().catch(() => null)) as {
      erro?: boolean;
      mensagem?: string;
      dados?: Record<string, unknown>[];
    } | null;
    if (!respostaConsulta.ok || !corpoConsulta) {
      throw new Error(`Facta respondeu ${respostaConsulta.status} na consulta`);
    }
    if (corpoConsulta.erro) {
      if (corpoConsulta.mensagem?.includes("Nenhum dado encontrado")) {
        return { tokenGerado: true, cpfConsultado: cpfLimpo, dados: null, mensagem: "Nenhum dado encontrado (CPF sem histórico na base offline da Facta)." };
      }
      throw new Error(corpoConsulta.mensagem || "Erro na consulta offline da Facta");
    }

    const primeiro = Array.isArray(corpoConsulta.dados) && corpoConsulta.dados.length > 0 ? corpoConsulta.dados[0] : null;
    return { tokenGerado: true, cpfConsultado: cpfLimpo, dados: primeiro, mensagem: "Consulta realizada com sucesso." };
  }

  // Ferramenta de teste da consulta ONLINE (04/09, 2ª etapa) — registra a
  // autorização de verdade e já tenta consultar em seguida (sem esperar a
  // janela normal de 60s, já que é um teste manual, não o worker
  // automático). Se a Facta ainda não tiver processado, devolve
  // "aindaProcessando: true" — não é erro, só significa que precisa
  // esperar mais e tentar de novo manualmente.
  async testarConsultaOnlineFacta(params: {
    cpf: string;
    nome: string;
    celular: string;
  }): Promise<{
    autorizacaoRegistrada: unknown;
    aindaProcessando: boolean;
    dados: Record<string, unknown> | null;
    mensagem: string;
  }> {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "FACTA_MARGEM_CREDENCIAIS" } });
    const valor = (config?.valor ?? {}) as {
      usuario?: string;
      senha?: string;
      baseUrlOnline?: string;
      averbadorOnline?: string;
      localizacaoIpOnline?: string;
      localizacaoAutorizacaoOnline?: string;
    };
    if (!valor.usuario || !valor.senha) {
      throw new Error("Credenciais da Facta não configuradas ainda (usuario/senha) — salve antes de testar.");
    }
    const baseUrl = (valor.baseUrlOnline || "https://webservice.facta.com.br").replace(/\/$/, "");
    const cpfLimpo = params.cpf.replace(/\D/g, "");

    const basic = Buffer.from(`${valor.usuario}:${valor.senha}`).toString("base64");
    const respostaToken = await fetch(`${baseUrl}/gera-token`, { method: "GET", headers: { Authorization: `Basic ${basic}` } });
    const corpoToken = (await respostaToken.json().catch(() => null)) as { erro?: boolean; mensagem?: string; token?: string } | null;
    if (!respostaToken.ok || !corpoToken || corpoToken.erro || !corpoToken.token) {
      throw new Error(corpoToken?.mensagem || `Facta respondeu ${respostaToken.status} ao gerar token (serviço online)`);
    }

    const pad = (n: number) => String(n).padStart(2, "0");
    const agora = new Date();
    const dataFormatada = `${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())} ${pad(agora.getHours())}:${pad(agora.getMinutes())}:${pad(agora.getSeconds())}`;

    const form = new FormData();
    form.append("averbador", valor.averbadorOnline || "10010");
    form.append("nome", params.nome);
    form.append("cpf", cpfLimpo);
    form.append("celular", params.celular);
    form.append("tipo_envio", "WHATSAPP");
    form.append("data_autorizacao_cliente", dataFormatada);
    form.append("localizacao_ip", valor.localizacaoIpOnline || "");
    form.append("localizacao_autorizacao", valor.localizacaoAutorizacaoOnline || "");

    const respostaAutorizacao = await fetch(`${baseUrl}/cadastrar-autorizacao-consulta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${corpoToken.token}` },
      body: form,
    });
    const corpoAutorizacao = (await respostaAutorizacao.json().catch(() => null)) as { erro?: boolean; mensagem?: string } | null;
    if (!respostaAutorizacao.ok || !corpoAutorizacao || corpoAutorizacao.erro) {
      throw new Error(corpoAutorizacao?.mensagem || `Facta respondeu ${respostaAutorizacao.status} ao registrar autorização`);
    }

    // Tenta consultar na hora (só pra teste manual — o worker de verdade
    // espera 60s antes da 1ª tentativa).
    const respostaConsulta = await fetch(`${baseUrl}/consignado-trabalhador/consulta-dados-trabalhador?cpf=${cpfLimpo}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${corpoToken.token}` },
    });
    const corpoConsulta = (await respostaConsulta.json().catch(() => null)) as {
      erro?: boolean;
      mensagem?: string;
      dados_trabalhador?: { dados?: Record<string, unknown>[] };
    } | null;

    if (!respostaConsulta.ok || !corpoConsulta) {
      return {
        autorizacaoRegistrada: corpoAutorizacao,
        aindaProcessando: true,
        dados: null,
        mensagem: `Autorização registrada. Consulta ainda não disponível (HTTP ${respostaConsulta.status}) — tente de novo em alguns segundos.`,
      };
    }
    if (corpoConsulta.erro) {
      return {
        autorizacaoRegistrada: corpoAutorizacao,
        aindaProcessando: true,
        dados: null,
        mensagem: `Autorização registrada. Consulta ainda respondeu "${corpoConsulta.mensagem}" — tente de novo em alguns segundos.`,
      };
    }

    const primeiro = corpoConsulta.dados_trabalhador?.dados?.[0] ?? null;
    return {
      autorizacaoRegistrada: corpoAutorizacao,
      aindaProcessando: false,
      dados: primeiro,
      mensagem: "Autorização registrada e consulta concluída com sucesso.",
    };
  }

  async salvarCredenciaisIntegracao(
    chave: "LEMIT_CREDENCIAIS" | "WHATSAPP_VALIDACAO_CREDENCIAIS",
    dados: {
      apiKey?: string;
      baseUrl?: string;
      urlConsulta?: string;
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
      urlConsulta?: string;
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
    // Editável no painel (03/09) — igual à baseUrl, não é segredo, então
    // "em branco = mantém a atual" também vale aqui (não precisa reescrever
    // toda vez que salva outra coisa no mesmo formulário).
    const urlConsulta =
      dados.urlConsulta !== undefined
        ? dados.urlConsulta.trim() === ""
          ? null
          : dados.urlConsulta.trim()
        : valorAtual.urlConsulta ?? null;
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
      urlConsulta,
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
        // "Status disparo" na lista (04/09, pedido explícito) — só a
        // tentativa MAIS RECENTE de disparo individual (de qualquer
        // endpoint), pra mostrar na coluna sem precisar abrir a oferta.
        include: {
          disparoIndividualTentativas: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
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

  // -------------------------------------------------------------------------
  // Qualidade WhatsApp (10/09) — ver schema.prisma (BmConta/WabaConta/
  // NumeroWhatsapp/NumeroWhatsappHistorico) pro contexto do domínio: cada BM
  // tem seu próprio app/token (é criado dentro da própria BM), e dentro de
  // uma BM pode haver mais de uma WABA — o token fica em BmConta, o WABA_ID
  // em WabaConta.
  // -------------------------------------------------------------------------

  async listarBmContasQualidadeWhatsapp(): Promise<BmContaQualidadeWhatsapp[]> {
    const bms = await this.prisma.bmConta.findMany({
      orderBy: { nome: "asc" },
      include: {
        wabas: {
          orderBy: { createdAt: "asc" },
          include: {
            _count: { select: { numeros: true } },
            // qualityRating de cada número (monta o resumo por cor) +
            // messagingLimitTier (11/09: a Meta passou a compartilhar esse
            // limite por BM inteira, não mais por número — ver
            // meta-qualidade-whatsapp.ts — então todo número de uma mesma BM
            // deveria vir com o mesmo valor; usamos o primeiro não-nulo que
            // encontrarmos como "o tier da BM").
            numeros: { select: { qualityRating: true, messagingLimitTier: true } },
          },
        },
      },
    });
    return bms.map((bm) => {
      const wabas = bm.wabas.map((w) => {
        const porQualidade: Record<string, number> = {};
        for (const numero of w.numeros) {
          porQualidade[numero.qualityRating] = (porQualidade[numero.qualityRating] ?? 0) + 1;
        }
        return {
          id: w.id,
          wabaId: w.wabaId,
          nome: w.nome,
          ativo: w.ativo,
          ultimaConsultaEm: w.ultimaConsultaEm,
          ultimoErro: w.ultimoErro,
          totalNumeros: w._count.numeros,
          porQualidade,
        };
      });
      const porQualidadeBm: Record<string, number> = {};
      for (const waba of wabas) {
        for (const rating of Object.keys(waba.porQualidade)) {
          porQualidadeBm[rating] = (porQualidadeBm[rating] ?? 0) + (waba.porQualidade[rating] ?? 0);
        }
      }
      // Tier por BM (11/09) — sem valor até a Meta devolver algo de verdade
      // pra pelo menos 1 número dessa BM; nunca inventamos um placeholder
      // aqui (pedido explícito: se não vier da Meta, não mostra nada).
      let tier: string | null = null;
      for (const waba of bm.wabas) {
        const encontrado = waba.numeros.find((n) => n.messagingLimitTier)?.messagingLimitTier;
        if (encontrado) {
          tier = encontrado;
          break;
        }
      }
      return {
        id: bm.id,
        nome: bm.nome,
        ativo: bm.ativo,
        ...mascararTokenBm(bm.tokenAcesso),
        ultimaConsultaEm: bm.ultimaConsultaEm,
        ultimoErro: bm.ultimoErro,
        wabas,
        porQualidade: porQualidadeBm,
        tier,
      };
    });
  }

  async criarBmContaQualidadeWhatsapp(params: { nome: string; tokenAcesso: string }): Promise<{ id: string }> {
    const bm = await this.prisma.bmConta.create({
      data: { nome: params.nome.trim(), tokenAcesso: params.tokenAcesso.trim() },
    });
    return { id: bm.id };
  }

  // tokenAcesso vazio/ausente = mantém o token atual (mesmo padrão de "deixe
  // em branco pra manter" usado nas outras credenciais do painel).
  async atualizarBmContaQualidadeWhatsapp(
    id: string,
    params: { nome?: string; tokenAcesso?: string; ativo?: boolean }
  ): Promise<void> {
    const data: Prisma.BmContaUpdateInput = {};
    if (params.nome !== undefined) data.nome = params.nome.trim();
    if (params.tokenAcesso) data.tokenAcesso = params.tokenAcesso.trim();
    if (params.ativo !== undefined) data.ativo = params.ativo;
    await this.prisma.bmConta.update({ where: { id }, data });
  }

  // Remove a BM e, em cascata (FK no banco — ver migração), todas as WABAs
  // dela e os números/histórico associados. Não tem como desfazer.
  async removerBmContaQualidadeWhatsapp(id: string): Promise<void> {
    await this.prisma.bmConta.delete({ where: { id } });
  }

  async criarWabaContaQualidadeWhatsapp(bmContaId: string, params: { wabaId: string; nome?: string }): Promise<{ id: string }> {
    const waba = await this.prisma.wabaConta.create({
      data: { bmContaId, wabaId: params.wabaId.trim(), nome: params.nome?.trim() || null },
    });
    return { id: waba.id };
  }

  async atualizarWabaContaQualidadeWhatsapp(
    id: string,
    params: { wabaId?: string; nome?: string; ativo?: boolean }
  ): Promise<void> {
    const data: Prisma.WabaContaUpdateInput = {};
    if (params.wabaId !== undefined) data.wabaId = params.wabaId.trim();
    if (params.nome !== undefined) data.nome = params.nome.trim() || null;
    if (params.ativo !== undefined) data.ativo = params.ativo;
    await this.prisma.wabaConta.update({ where: { id }, data });
  }

  // Remove a WABA e, em cascata, os números/histórico associados a ela (o
  // resto da BM e as outras WABAs dela não são afetados).
  async removerWabaContaQualidadeWhatsapp(id: string): Promise<void> {
    await this.prisma.wabaConta.delete({ where: { id } });
  }

  async statusQualidadeWhatsapp(): Promise<QualidadeWhatsappConfigStatus> {
    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "QUALIDADE_WHATSAPP_CONFIG" } });
    const valor = (config?.valor ?? {}) as {
      intervaloSegundos?: number;
      versaoGraphApi?: string;
    };
    return {
      ativo: config?.ativo ?? false,
      intervaloSegundos: typeof valor.intervaloSegundos === "number" && valor.intervaloSegundos > 0 ? valor.intervaloSegundos : null,
      versaoGraphApi: valor.versaoGraphApi || null,
    };
  }

  // batchSize removido (11/09) — a consulta automática agora sempre pega
  // TODAS as WABAs ativas a cada ciclo (ver wabasQualidadeParaConsultar
  // abaixo, sem limite); webhookAlertaUrl removido daqui também — o alerta
  // por piora foi substituído pelo relatório periódico completo (ver
  // statusRelatorioQualidadeWhatsapp/salvarConfigRelatorioQualidadeWhatsapp
  // mais abaixo).
  async salvarConfigQualidadeWhatsapp(params: {
    ativo: boolean;
    intervaloSegundos?: number;
    versaoGraphApi?: string;
  }): Promise<void> {
    const valor = {
      intervaloSegundos: params.intervaloSegundos,
      versaoGraphApi: params.versaoGraphApi,
    };
    await this.prisma.integrationConfig.upsert({
      where: { chave: "QUALIDADE_WHATSAPP_CONFIG" },
      update: { valor, ativo: params.ativo },
      create: { chave: "QUALIDADE_WHATSAPP_CONFIG", valor, ativo: params.ativo },
    });
  }

  async setQualidadeWhatsappAtivo(ativo: boolean): Promise<void> {
    await this.prisma.integrationConfig.upsert({
      where: { chave: "QUALIDADE_WHATSAPP_CONFIG" },
      update: { ativo },
      create: { chave: "QUALIDADE_WHATSAPP_CONFIG", ativo, valor: {} },
    });
  }

  // -------------------------------------------------------------------------
  // Webhook de Relatório de Qualidade WhatsApp (11/09) — substitui o antigo
  // alerta "só quando piora": agora, no seu próprio ciclo (config separada da
  // consulta automática acima), manda 1 POST com TODOS os números
  // cadastrados e a qualidade atual de cada um (alta/média/baixa/desconhecida).
  // -------------------------------------------------------------------------

  async statusRelatorioQualidadeWhatsapp(): Promise<QualidadeWhatsappRelatorioConfigStatus> {
    const config = await this.prisma.integrationConfig.findUnique({
      where: { chave: "QUALIDADE_WHATSAPP_RELATORIO_CONFIG" },
    });
    const valor = (config?.valor ?? {}) as { intervaloSegundos?: number; webhookUrl?: string };
    return {
      ativo: config?.ativo ?? false,
      intervaloSegundos: typeof valor.intervaloSegundos === "number" && valor.intervaloSegundos > 0 ? valor.intervaloSegundos : null,
      webhookUrl: valor.webhookUrl || null,
    };
  }

  async salvarConfigRelatorioQualidadeWhatsapp(params: {
    ativo: boolean;
    intervaloSegundos?: number;
    webhookUrl?: string;
  }): Promise<void> {
    const valor = { intervaloSegundos: params.intervaloSegundos, webhookUrl: params.webhookUrl };
    await this.prisma.integrationConfig.upsert({
      where: { chave: "QUALIDADE_WHATSAPP_RELATORIO_CONFIG" },
      update: { valor, ativo: params.ativo },
      create: { chave: "QUALIDADE_WHATSAPP_RELATORIO_CONFIG", valor, ativo: params.ativo },
    });
  }

  async setRelatorioQualidadeWhatsappAtivo(ativo: boolean): Promise<void> {
    await this.prisma.integrationConfig.upsert({
      where: { chave: "QUALIDADE_WHATSAPP_RELATORIO_CONFIG" },
      update: { ativo },
      create: { chave: "QUALIDADE_WHATSAPP_RELATORIO_CONFIG", ativo, valor: {} },
    });
  }

  // Todos os números cadastrados (sem filtro nenhum) com o mínimo que o
  // relatório periódico precisa: os dois identificadores (o phoneNumberId da
  // Meta E o telefone) + a qualidade atual + de qual BM/WABA é, pra dar
  // contexto no relatório. Reaproveita o mesmo formato cru (GREEN/YELLOW/
  // RED/UNKNOWN) — quem traduz pro rótulo alta/média/baixa/desconhecida é o
  // worker11 (apps/workers), não este repositório.
  async listarNumerosParaRelatorioQualidadeWhatsapp(): Promise<NumeroQualidadeParaRelatorio[]> {
    const numeros = await this.prisma.numeroWhatsapp.findMany({
      include: { wabaConta: { include: { bmConta: true } } },
    });
    return numeros.map((n) => ({
      phoneNumberId: n.phoneNumberId,
      displayPhoneNumber: n.displayPhoneNumber,
      qualityRating: n.qualityRating,
      wabaId: n.wabaConta.wabaId,
      bmNome: n.wabaConta.bmConta.nome,
    }));
  }

  // KPIs agregados pro topo do painel — conta todos os números de uma vez
  // (a escala esperada, dezenas de BMs x poucos números cada, cabe tranquilo
  // num findMany só; se um dia isso crescer muito, dá pra trocar por um
  // groupBy sem mudar a assinatura do método).
  async resumoQualidadeWhatsapp(): Promise<ResumoQualidadeWhatsapp> {
    const [totalBms, totalWabas, numeros] = await Promise.all([
      this.prisma.bmConta.count(),
      this.prisma.wabaConta.count(),
      this.prisma.numeroWhatsapp.findMany({ select: { qualityRating: true, messagingLimitTier: true, atualizadoEm: true } }),
    ]);

    const porQualidade: Record<string, number> = {};
    const porTier: Record<string, number> = {};
    let ultimaAtualizacao: Date | null = null;
    for (const n of numeros) {
      porQualidade[n.qualityRating] = (porQualidade[n.qualityRating] ?? 0) + 1;
      const tier = n.messagingLimitTier ?? "DESCONHECIDO";
      porTier[tier] = (porTier[tier] ?? 0) + 1;
      if (!ultimaAtualizacao || n.atualizadoEm > ultimaAtualizacao) ultimaAtualizacao = n.atualizadoEm;
    }

    return { totalNumeros: numeros.length, totalBms, totalWabas, porQualidade, porTier, ultimaAtualizacao };
  }

  async listarNumerosQualidadeWhatsapp(filtros?: {
    bmContaId?: string;
    qualityRating?: string;
    busca?: string;
  }): Promise<NumeroWhatsappListItem[]> {
    const where: Prisma.NumeroWhatsappWhereInput = {};
    if (filtros?.qualityRating) where.qualityRating = filtros.qualityRating;
    if (filtros?.bmContaId) where.wabaConta = { bmContaId: filtros.bmContaId };
    if (filtros?.busca) {
      where.OR = [
        { displayPhoneNumber: { contains: filtros.busca, mode: "insensitive" } },
        { verifiedName: { contains: filtros.busca, mode: "insensitive" } },
      ];
    }

    const numeros = await this.prisma.numeroWhatsapp.findMany({
      where,
      orderBy: { atualizadoEm: "desc" },
      include: { wabaConta: { include: { bmConta: true } } },
    });

    return numeros.map((n) => ({
      id: n.id,
      displayPhoneNumber: n.displayPhoneNumber,
      verifiedName: n.verifiedName,
      qualityRating: n.qualityRating,
      messagingLimitTier: n.messagingLimitTier,
      status: n.status,
      atualizadoEm: n.atualizadoEm,
      wabaId: n.wabaConta.wabaId,
      wabaNome: n.wabaConta.nome,
      bmContaId: n.wabaConta.bmContaId,
      bmNome: n.wabaConta.bmConta.nome,
    }));
  }

  // Usado pela tela de detalhe/histórico de 1 número (painel) — igual ao
  // mapeamento de listarNumerosQualidadeWhatsapp acima, mas buscando só 1.
  async numeroQualidadeWhatsappPorId(id: string): Promise<NumeroWhatsappListItem | null> {
    const n = await this.prisma.numeroWhatsapp.findUnique({
      where: { id },
      include: { wabaConta: { include: { bmConta: true } } },
    });
    if (!n) return null;
    return {
      id: n.id,
      displayPhoneNumber: n.displayPhoneNumber,
      verifiedName: n.verifiedName,
      qualityRating: n.qualityRating,
      messagingLimitTier: n.messagingLimitTier,
      status: n.status,
      atualizadoEm: n.atualizadoEm,
      wabaId: n.wabaConta.wabaId,
      wabaNome: n.wabaConta.nome,
      bmContaId: n.wabaConta.bmContaId,
      bmNome: n.wabaConta.bmConta.nome,
    };
  }

  async historicoNumeroQualidadeWhatsapp(
    numeroId: string,
    limite = 200
  ): Promise<{ consultadoEm: Date; qualityRating: string; messagingLimitTier: string | null; status: string | null }[]> {
    const linhas = await this.prisma.numeroWhatsappHistorico.findMany({
      where: { numeroId },
      orderBy: { consultadoEm: "asc" },
      take: limite,
    });
    return linhas.map((l) => ({
      consultadoEm: l.consultadoEm,
      qualityRating: l.qualityRating,
      messagingLimitTier: l.messagingLimitTier,
      status: l.status,
    }));
  }

  // ---- daqui pra baixo: métodos usados pelo worker10 (não pelo painel) ----

  // TODAS as WABAs ativas de BMs ativas, sempre (11/09 — antes era um lote
  // limitado por ciclo, com rodízio; o usuário pediu pra tirar o lote e
  // consultar tudo de uma vez todo ciclo). Mantém a ordenação por
  // ultimaConsultaEm (nulls first) só por organização/depuração — não tem
  // mais efeito de "rodízio" já que não há mais corte por limite.
  async wabasQualidadeParaConsultar(): Promise<WabaParaConsultarQualidade[]> {
    const wabas = await this.prisma.wabaConta.findMany({
      where: { ativo: true, bmConta: { ativo: true } },
      orderBy: [{ ultimaConsultaEm: { sort: "asc", nulls: "first" } }],
      include: { bmConta: true },
    });
    return wabas.map((w) => ({
      id: w.id,
      wabaId: w.wabaId,
      bmContaId: w.bmContaId,
      bmNome: w.bmConta.nome,
      tokenAcesso: w.bmConta.tokenAcesso,
    }));
  }

  // Upsert de cada número (por phoneNumberId, que é o "id" da Meta) + 1 linha
  // de histórico por número a CADA consulta (mesmo sem mudança nenhuma —
  // pedido explícito, pra dar pra ver no gráfico que a checagem realmente
  // rodou naquele horário). A comparação com o valor ANTERIOR (pra decidir
  // se piorou) usa avaliarPioraQualidade (@plataforma-ofertas/domain) — puro,
  // testado à parte, sem depender do Postgres.
  async registrarConsultaWabaSucesso(params: {
    wabaContaId: string;
    numeros: NumeroWhatsappConsultado[];
  }): Promise<{ pioraram: NumeroWhatsappPiorouQualidade[] }> {
    const waba = await this.prisma.wabaConta.findUnique({
      where: { id: params.wabaContaId },
      include: { bmConta: true },
    });
    if (!waba) return { pioraram: [] };

    const pioraram: NumeroWhatsappPiorouQualidade[] = [];

    for (const item of params.numeros) {
      if (!item.phoneNumberId) continue; // resposta malformada da Meta — não tem como identificar o número, ignora essa linha

      const anterior = await this.prisma.numeroWhatsapp.findUnique({ where: { phoneNumberId: item.phoneNumberId } });

      const { piorou, motivo } = avaliarPioraQualidade(
        anterior
          ? { qualityRating: anterior.qualityRating, messagingLimitTier: anterior.messagingLimitTier, status: anterior.status }
          : null,
        item
      );

      const numero = await this.prisma.numeroWhatsapp.upsert({
        where: { phoneNumberId: item.phoneNumberId },
        update: {
          wabaContaId: params.wabaContaId,
          displayPhoneNumber: item.displayPhoneNumber,
          verifiedName: item.verifiedName,
          qualityRating: item.qualityRating,
          messagingLimitTier: item.messagingLimitTier,
          status: item.status,
        },
        create: {
          wabaContaId: params.wabaContaId,
          phoneNumberId: item.phoneNumberId,
          displayPhoneNumber: item.displayPhoneNumber,
          verifiedName: item.verifiedName,
          qualityRating: item.qualityRating,
          messagingLimitTier: item.messagingLimitTier,
          status: item.status,
        },
      });

      await this.prisma.numeroWhatsappHistorico.create({
        data: {
          numeroId: numero.id,
          qualityRating: item.qualityRating,
          messagingLimitTier: item.messagingLimitTier,
          status: item.status,
        },
      });

      if (piorou && motivo) {
        pioraram.push({
          numeroId: numero.id,
          displayPhoneNumber: item.displayPhoneNumber,
          wabaId: waba.wabaId,
          bmNome: waba.bmConta.nome,
          motivo,
          qualityRatingAnterior: anterior?.qualityRating ?? null,
          qualityRatingAtual: item.qualityRating,
        });
      }
    }

    await this.prisma.wabaConta.update({
      where: { id: params.wabaContaId },
      data: { ultimaConsultaEm: new Date(), ultimoErro: null },
    });

    return { pioraram };
  }

  async registrarConsultaWabaErro(wabaContaId: string, mensagem: string): Promise<void> {
    await this.prisma.wabaConta.update({
      where: { id: wabaContaId },
      data: { ultimaConsultaEm: new Date(), ultimoErro: mensagem },
    });
  }

  // Ferramenta de teste (10/09, mesmo espírito do testarConsultaFacta acima):
  // consulta 1 WABA específica na Meta AGORA (sem esperar o rodízio do
  // worker10) e já grava o resultado de verdade (estado atual + histórico +
  // ultimaConsultaEm) — diferente do teste da Facta, que só mostra o
  // resultado sem persistir nada, aqui persistir é o comportamento certo:
  // é literalmente a mesma operação que o worker faria pra essa WABA, só
  // que na hora. Reimplementa a chamada HTTP à parte (não importa o cliente
  // de apps/workers — packages/database não depende de apps/*), igual o
  // padrão já usado pra Facta.
  async testarWabaQualidadeWhatsapp(
    wabaContaId: string
  ): Promise<{ numeros: NumeroWhatsappConsultado[]; pioraram: NumeroWhatsappPiorouQualidade[] }> {
    const waba = await this.prisma.wabaConta.findUnique({ where: { id: wabaContaId }, include: { bmConta: true } });
    if (!waba) throw new Error("WABA não encontrada.");

    const config = await this.prisma.integrationConfig.findUnique({ where: { chave: "QUALIDADE_WHATSAPP_CONFIG" } });
    const valorConfig = (config?.valor ?? {}) as { versaoGraphApi?: string };
    const versaoBruta = (valorConfig.versaoGraphApi || "v21.0").trim();
    const versao = versaoBruta.startsWith("v") ? versaoBruta : `v${versaoBruta}`;

    const url = `https://graph.facebook.com/${versao}/${encodeURIComponent(
      waba.wabaId
    )}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,whatsapp_business_manager_messaging_limit,status`;

    const resposta = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${waba.bmConta.tokenAcesso}` } });
    const textoBruto = await resposta.text();
    let corpo: unknown = {};
    if (textoBruto) {
      try {
        corpo = JSON.parse(textoBruto);
      } catch {
        corpo = { raw: textoBruto };
      }
    }

    if (!resposta.ok) {
      const erroMeta = (corpo as { error?: { message?: string; error_user_msg?: string } } | undefined)?.error;
      const mensagem = erroMeta?.error_user_msg || erroMeta?.message || `Meta respondeu HTTP ${resposta.status}`;
      await this.registrarConsultaWabaErro(wabaContaId, mensagem);
      throw new Error(mensagem);
    }

    const dadosBrutos = (corpo as { data?: unknown[] }).data;
    const numeros: NumeroWhatsappConsultado[] = Array.isArray(dadosBrutos)
      ? dadosBrutos.map((item) => {
          const i = (item ?? {}) as Record<string, unknown>;
          return {
            phoneNumberId: String(i.id ?? ""),
            displayPhoneNumber: typeof i.display_phone_number === "string" ? i.display_phone_number : "",
            verifiedName: typeof i.verified_name === "string" ? i.verified_name : null,
            qualityRating: typeof i.quality_rating === "string" && i.quality_rating ? i.quality_rating : "UNKNOWN",
            messagingLimitTier:
              typeof i.whatsapp_business_manager_messaging_limit === "string" ? i.whatsapp_business_manager_messaging_limit : null,
            status: typeof i.status === "string" ? i.status : null,
          };
        })
      : [];

    const { pioraram } = await this.registrarConsultaWabaSucesso({ wabaContaId, numeros });
    return { numeros, pioraram };
  }
}

// ---------------------------------------------------------------------------
// Tipos — Qualidade WhatsApp (10/09)
// ---------------------------------------------------------------------------

export interface WabaContaQualidadeWhatsapp {
  id: string;
  wabaId: string;
  nome: string | null;
  ativo: boolean;
  ultimaConsultaEm: Date | null;
  ultimoErro: string | null;
  totalNumeros: number;
  // Contagem de números dessa WABA por qualityRating (GREEN/YELLOW/RED/UNKNOWN)
  // — alimenta o resumo de qualidade mostrado no card da WABA no painel.
  porQualidade: Record<string, number>;
}

export interface BmContaQualidadeWhatsapp {
  id: string;
  nome: string;
  ativo: boolean;
  tokenConfigurado: boolean;
  tokenMascarado: string | null;
  ultimaConsultaEm: Date | null;
  ultimoErro: string | null;
  wabas: WabaContaQualidadeWhatsapp[];
  // Soma do porQualidade de todas as WABAs dessa BM — dá o resumo de saúde
  // da BM inteira sem precisar abrir cada WABA (importante com ~50 BMs).
  porQualidade: Record<string, number>;
  // Limite de disparo da BM inteira (11/09 — a Meta passou a compartilhar
  // esse valor por BM, não mais por número). null quando a Meta ainda não
  // devolveu esse dado pra nenhum número dessa BM — nesse caso o painel não
  // mostra nada (nunca um placeholder tipo "—" ou "0").
  tier: string | null;
}

export interface QualidadeWhatsappConfigStatus {
  ativo: boolean;
  intervaloSegundos: number | null;
  versaoGraphApi: string | null;
}

export interface QualidadeWhatsappRelatorioConfigStatus {
  ativo: boolean;
  intervaloSegundos: number | null;
  webhookUrl: string | null;
}

export interface NumeroQualidadeParaRelatorio {
  phoneNumberId: string;
  displayPhoneNumber: string;
  qualityRating: string;
  wabaId: string;
  bmNome: string;
}

export interface ResumoQualidadeWhatsapp {
  totalNumeros: number;
  totalBms: number;
  totalWabas: number;
  porQualidade: Record<string, number>;
  porTier: Record<string, number>;
  ultimaAtualizacao: Date | null;
}

export interface NumeroWhatsappListItem {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string;
  messagingLimitTier: string | null;
  status: string | null;
  atualizadoEm: Date;
  wabaId: string;
  wabaNome: string | null;
  bmContaId: string;
  bmNome: string;
}

export interface WabaParaConsultarQualidade {
  id: string;
  wabaId: string;
  bmContaId: string;
  bmNome: string;
  tokenAcesso: string;
}

export interface NumeroWhatsappConsultado {
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string;
  messagingLimitTier: string | null;
  status: string | null;
}

export interface NumeroWhatsappPiorouQualidade {
  numeroId: string;
  displayPhoneNumber: string;
  wabaId: string;
  bmNome: string;
  motivo: string;
  qualityRatingAnterior: string | null;
  qualityRatingAtual: string;
}
