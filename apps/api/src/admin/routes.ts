import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AdminRepository } from "@plataforma-ofertas/database";
import { requireAdminAuth } from "./auth";

const ESQUEMAS_ASSINATURA_VALIDOS = ["ofertas_v1", "hmac_sha256_simple", "token_simples"];

// API do painel administrativo (seção 8 do doc de arquitetura / itens 31-38 do
// escopo original): dashboard, toggle do Limit, CRUD de endpoints e regras de
// roteamento, listagem/detalhe/timeline de ofertas. Tudo sob /admin, protegido por
// requireAdminAuth.
export function registerAdminRoutes(app: FastifyInstance, adminRepo: AdminRepository): void {
  app.register(
    async (instance) => {
      instance.addHook("onRequest", requireAdminAuth);

      instance.get<{ Querystring: { status?: string } }>("/dashboard", async (request) => {
        const statuses = request.query.status ? request.query.status.split(",").filter(Boolean) : undefined;
        return adminRepo.dashboardSummary({ statuses });
      });
      instance.get<{ Querystring: { from?: string; to?: string; status?: string } }>("/dashboard/kpis", async (request) => {
        const from = request.query.from ? new Date(request.query.from) : undefined;
        const to = request.query.to ? new Date(request.query.to) : undefined;
        const statuses = request.query.status ? request.query.status.split(",").filter(Boolean) : undefined;
        return adminRepo.dashboardKpis({
          from: from && !Number.isNaN(from.getTime()) ? from : undefined,
          to: to && !Number.isNaN(to.getTime()) ? to : undefined,
          statuses,
        });
      });
      instance.get<{ Querystring: { from?: string; to?: string; status?: string } }>("/dashboard/timeseries", async (request) => {
        const from = request.query.from ? new Date(request.query.from) : undefined;
        const to = request.query.to ? new Date(request.query.to) : undefined;
        const statuses = request.query.status ? request.query.status.split(",").filter(Boolean) : undefined;
        return adminRepo.dashboardTimeseries({
          from: from && !Number.isNaN(from.getTime()) ? from : undefined,
          to: to && !Number.isNaN(to.getTime()) ? to : undefined,
          statuses,
        });
      });
      instance.get<{ Querystring: { from?: string; to?: string } }>("/dashboard/enviados-vs-respondidos", async (request) => {
        const from = request.query.from ? new Date(request.query.from) : undefined;
        const to = request.query.to ? new Date(request.query.to) : undefined;
        return adminRepo.dashboardEnviadosVsRespondidos({
          from: from && !Number.isNaN(from.getTime()) ? from : undefined,
          to: to && !Number.isNaN(to.getTime()) ? to : undefined,
        });
      });
      instance.get<{ Querystring: { from?: string; to?: string } }>("/dashboard/recebidas-vs-enviados", async (request) => {
        const from = request.query.from ? new Date(request.query.from) : undefined;
        const to = request.query.to ? new Date(request.query.to) : undefined;
        return adminRepo.dashboardRecebidasVsEnviados({
          from: from && !Number.isNaN(from.getTime()) ? from : undefined,
          to: to && !Number.isNaN(to.getTime()) ? to : undefined,
        });
      });
      instance.get<{ Querystring: { from?: string; to?: string } }>("/dashboard/horario-resposta", async (request) => {
        const from = request.query.from ? new Date(request.query.from) : undefined;
        const to = request.query.to ? new Date(request.query.to) : undefined;
        return adminRepo.dashboardHorarioResposta({
          from: from && !Number.isNaN(from.getTime()) ? from : undefined,
          to: to && !Number.isNaN(to.getTime()) ? to : undefined,
        });
      });
      instance.get<{ Querystring: { from?: string; to?: string } }>("/dashboard/tempo-medio-etapas", async (request) => {
        const from = request.query.from ? new Date(request.query.from) : undefined;
        const to = request.query.to ? new Date(request.query.to) : undefined;
        return adminRepo.dashboardTempoMedioEtapas({
          from: from && !Number.isNaN(from.getTime()) ? from : undefined,
          to: to && !Number.isNaN(to.getTime()) ? to : undefined,
        });
      });
      instance.get<{ Querystring: { from?: string; to?: string } }>("/dashboard/taxa-resposta-parceiro", async (request) => {
        const from = request.query.from ? new Date(request.query.from) : undefined;
        const to = request.query.to ? new Date(request.query.to) : undefined;
        return adminRepo.dashboardTaxaRespostaPorWebhook({
          from: from && !Number.isNaN(from.getTime()) ? from : undefined,
          to: to && !Number.isNaN(to.getTime()) ? to : undefined,
        });
      });
      instance.get("/dashboard/webhooks", async () => adminRepo.dashboardPorWebhook());
      instance.get("/dashboard/bancos", async () => adminRepo.dashboardPorBanco());
      instance.get("/dashboard/endpoints", async () => adminRepo.dashboardPorEndpoint());

      instance.get("/integrations/limit", async () => {
        const [config, stats] = await Promise.all([adminRepo.getLimitConfig(), adminRepo.limitStats()]);
        return { ativo: config?.ativo ?? false, ...stats };
      });

      instance.post<{ Body: { ativo: boolean } }>("/integrations/limit", async (request) => {
        const updated = await adminRepo.setLimitEnabled(Boolean(request.body?.ativo));
        return { ativo: updated.ativo };
      });

      // Credenciais da Lemit e da CorbanTech (WhatsApp), editáveis aqui — os workers
      // leem do banco a cada ciclo, então não precisa reiniciar nada no servidor.
      instance.get("/integrations/credenciais", async () => adminRepo.getCredenciaisIntegracoes());

      instance.post<{
        Body: {
          integracao?: string;
          apiKey?: string;
          baseUrl?: string;
          intervaloSegundos?: number;
          limiteRequisicoesPorCiclo?: number;
          loteMinimo?: number;
          loteMaximo?: number;
          tempoMaximoEsperaLoteMinutos?: number;
        };
      }>("/integrations/credenciais", async (request, reply) => {
        const body = request.body ?? {};
        const chaveMap: Record<string, "LEMIT_CREDENCIAIS" | "WHATSAPP_VALIDACAO_CREDENCIAIS"> = {
          lemit: "LEMIT_CREDENCIAIS",
          whatsapp: "WHATSAPP_VALIDACAO_CREDENCIAIS",
        };
        const chave = body.integracao ? chaveMap[body.integracao] : undefined;
        if (!chave) {
          reply.code(400);
          return { error: "integracao_invalida", validos: Object.keys(chaveMap) };
        }
        await adminRepo.salvarCredenciaisIntegracao(chave, {
          apiKey: body.apiKey,
          baseUrl: body.baseUrl,
          intervaloSegundos: body.intervaloSegundos,
          limiteRequisicoesPorCiclo: body.limiteRequisicoesPorCiclo,
          loteMinimo: body.loteMinimo,
          loteMaximo: body.loteMaximo,
          tempoMaximoEsperaLoteMinutos: body.tempoMaximoEsperaLoteMinutos,
        });
        const atualizado = await adminRepo.getCredenciaisIntegracoes();
        return atualizado[body.integracao as "lemit" | "whatsapp"];
      });

      // Relatório periódico: envia os KPIs do dia (mesmas contagens do
      // /dashboard/kpis) por POST simples pro endpoint cadastrado aqui, na
      // frequência configurada (worker7-relatorio-periodico, apps/workers).
      instance.get("/integrations/relatorio-periodico", async () => adminRepo.getRelatorioPeriodicoConfig());

      instance.post<{
        Body: {
          ativo?: boolean;
          endpointUrl?: string;
          intervaloHoras?: number;
          horaInicio?: string;
          horaFim?: string;
        };
      }>("/integrations/relatorio-periodico", async (request) => {
        const body = request.body ?? {};
        await adminRepo.salvarRelatorioPeriodicoConfig({
          ativo: body.ativo,
          endpointUrl: body.endpointUrl,
          intervaloHoras: body.intervaloHoras,
          horaInicio: body.horaInicio,
          horaFim: body.horaFim,
        });
        return adminRepo.getRelatorioPeriodicoConfig();
      });

      // Disparo individual: mesma ideia do relatório periódico, mas em vez
      // de mandar um resumo, empurra 1 lead aguardando disparo por ciclo,
      // PRA CADA endpoint ativo cadastrado (vários endpoints = vários "1
      // por ciclo" em paralelo, multiplicando o throughput total).
      instance.get("/integrations/disparo-individual", async () => adminRepo.getDisparoIndividualConfig());

      instance.post<{
        Body: {
          ativo?: boolean;
          endpoints?: { id: string; url: string; ativo: boolean; modelo?: "hyperflow" | "ararahq" }[];
          intervaloSegundos?: number;
          ararahqApiKey?: string;
        };
      }>("/integrations/disparo-individual", async (request) => {
        const body = request.body ?? {};
        await adminRepo.salvarDisparoIndividualConfig({
          ativo: body.ativo,
          endpoints: body.endpoints,
          intervaloSegundos: body.intervaloSegundos,
          ararahqApiKey: body.ararahqApiKey,
        });
        return adminRepo.getDisparoIndividualConfig();
      });

      instance.get("/webhooks", async () => adminRepo.listWebhooks());

      instance.post<{
        Body: {
          identificador?: string;
          origem?: string;
          secretHmac?: string;
          esquemaAssinatura?: string;
          headerAssinatura?: string;
          headerTimestamp?: string | null;
        };
      }>("/webhooks", async (request, reply) => {
        const body = request.body ?? {};
        if (!body.identificador || !body.origem) {
          reply.code(400);
          return { error: "identificador_e_origem_obrigatorios" };
        }
        const esquemaAssinatura = body.esquemaAssinatura || "ofertas_v1";
        if (!ESQUEMAS_ASSINATURA_VALIDOS.includes(esquemaAssinatura)) {
          reply.code(400);
          return { error: "esquema_assinatura_invalido", validos: ESQUEMAS_ASSINATURA_VALIDOS };
        }
        const usaOfertasV1 = esquemaAssinatura === "ofertas_v1";
        try {
          const webhook = await adminRepo.createWebhook({
            identificador: body.identificador,
            origem: body.origem,
            // Se o parceiro não mandou o próprio secret (ex.: quando é a gente quem
            // define e passa pra eles), geramos um aleatório em vez de deixar vazio.
            secretHmac: body.secretHmac || randomBytes(32).toString("hex"),
            esquemaAssinatura,
            headerAssinatura: (body.headerAssinatura || (usaOfertasV1 ? "x-ofertas-signature" : "")).toLowerCase(),
            headerTimestamp: usaOfertasV1 ? (body.headerTimestamp || "x-ofertas-timestamp").toLowerCase() : null,
          });
          reply.code(201);
          return webhook;
        } catch (error) {
          // P2002 = violação de unique constraint do Prisma — já existe um webhook
          // com esse identificador (ex.: reenvio duplo do formulário, ou alguém já
          // cadastrou esse parceiro antes). Erro amigável em vez do 500 cru.
          if (isPrismaUniqueConstraintError(error)) {
            reply.code(409);
            return {
              error: "identificador_ja_existe",
              mensagem: `Já existe um webhook com o identificador "${body.identificador}". Use outro identificador ou edite/exclua o existente.`,
            };
          }
          throw error;
        }
      });

      instance.patch<{
        Params: { id: string };
        Body: {
          origem?: string;
          ativo?: boolean;
          secretHmac?: string;
          esquemaAssinatura?: string;
          headerAssinatura?: string;
          headerTimestamp?: string | null;
        };
      }>("/webhooks/:id", async (request, reply) => {
        const body = request.body ?? {};
        if (body.esquemaAssinatura && !ESQUEMAS_ASSINATURA_VALIDOS.includes(body.esquemaAssinatura)) {
          reply.code(400);
          return { error: "esquema_assinatura_invalido", validos: ESQUEMAS_ASSINATURA_VALIDOS };
        }
        return adminRepo.updateWebhook(request.params.id, {
          ...(body.origem !== undefined ? { origem: body.origem } : {}),
          ...(body.ativo !== undefined ? { ativo: body.ativo } : {}),
          ...(body.secretHmac ? { secretHmac: body.secretHmac } : {}),
          ...(body.esquemaAssinatura ? { esquemaAssinatura: body.esquemaAssinatura } : {}),
          ...(body.headerAssinatura ? { headerAssinatura: body.headerAssinatura.toLowerCase() } : {}),
          ...(body.headerTimestamp !== undefined
            ? { headerTimestamp: body.headerTimestamp ? body.headerTimestamp.toLowerCase() : null }
            : {}),
        });
      });

      // Excluir um parceiro só é permitido se ele nunca recebeu nenhum lead — caso
      // contrário a exclusão quebraria a referência dos leads antigos (webhook_id)
      // e perderíamos o histórico. Com leads no histórico, o jeito é "Desativar"
      // em vez de excluir.
      instance.delete<{ Params: { id: string } }>("/webhooks/:id", async (request, reply) => {
        const totalLeads = await adminRepo.countOffersForWebhook(request.params.id);
        if (totalLeads > 0) {
          reply.code(409);
          return {
            error: "parceiro_tem_leads",
            totalLeads,
            mensagem: `Esse parceiro já recebeu ${totalLeads} lead(s). Não é possível excluir sem perder o histórico — use "Desativar" em vez disso.`,
          };
        }
        await adminRepo.deleteWebhook(request.params.id);
        reply.code(204);
        return;
      });

      instance.get("/endpoints", async () => adminRepo.listEndpoints());

      instance.post<{ Body: Record<string, unknown> }>("/endpoints", async (request, reply) => {
        const endpoint = await adminRepo.createEndpoint(request.body as never);
        reply.code(201);
        return endpoint;
      });

      instance.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
        "/endpoints/:id",
        async (request) => adminRepo.updateEndpoint(request.params.id, request.body as never)
      );

      instance.get("/routing-rules", async () => adminRepo.listRoutingRules());

      instance.post<{ Body: Record<string, unknown> }>("/routing-rules", async (request, reply) => {
        const rule = await adminRepo.createRoutingRule(request.body as never);
        reply.code(201);
        return rule;
      });

      instance.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
        "/routing-rules/:id",
        async (request) => adminRepo.updateRoutingRule(request.params.id, request.body as never)
      );

      instance.get<{ Querystring: { status?: string; cpf?: string; limit?: string; offset?: string } }>(
        "/offers",
        async (request) => {
          const limit = Math.min(Number(request.query.limit ?? 50) || 50, 200);
          const offset = Math.max(Number(request.query.offset ?? 0) || 0, 0);
          return adminRepo.listOffers({ status: request.query.status, cpf: request.query.cpf, limit, offset });
        }
      );

      // Sem paginação — pro módulo de Relatórios (baixa tudo que bate com o
      // filtro de uma vez, pra virar planilha). Aceita múltiplos status
      // separados por vírgula, diferente de /offers acima (que só aceita 1).
      instance.get<{ Querystring: { status?: string; from?: string; to?: string } }>(
        "/offers/export",
        async (request) => {
          const statuses = request.query.status ? request.query.status.split(",").filter(Boolean) : undefined;
          const from = request.query.from ? new Date(request.query.from) : undefined;
          const to = request.query.to ? new Date(request.query.to) : undefined;
          return adminRepo.listOffersParaRelatorio({
            statuses,
            from: from && !Number.isNaN(from.getTime()) ? from : undefined,
            to: to && !Number.isNaN(to.getTime()) ? to : undefined,
          });
        }
      );

      instance.get<{ Params: { id: string } }>("/offers/:id", async (request, reply) => {
        const result = await adminRepo.getOfferTimeline(request.params.id);
        if (!result) {
          reply.code(404).send({ error: "oferta_nao_encontrada" });
          return;
        }
        return result;
      });

      // -- Login individual / usuários do painel ---------------------------
      // Ainda protegidas pelo mesmo requireAdminAuth (token estático) do resto
      // do /admin — só o servidor Next.js (que já tem esse token) chama essas
      // rotas; o login "de verdade" (sessão por token de usuário individual)
      // é uma camada por cima disso, específica pra saber QUAL humano está no
      // navegador. Ver comentário completo em admin-repository.ts.

      instance.post<{ Body: { email?: string; senha?: string } }>("/auth/login", async (request, reply) => {
        const { email, senha } = request.body ?? {};
        if (!email || !senha) {
          reply.code(400);
          return { error: "campos_obrigatorios", mensagem: "E-mail e senha são obrigatórios." };
        }
        const usuario = await adminRepo.verificarLogin(email, senha);
        if (!usuario) {
          reply.code(401);
          return { error: "credenciais_invalidas", mensagem: "E-mail ou senha incorretos." };
        }
        const token = await adminRepo.criarSessao(usuario.id);
        return { token, usuario };
      });

      instance.get<{ Querystring: { token?: string } }>("/auth/me", async (request, reply) => {
        const token = request.query.token;
        if (!token) {
          reply.code(401);
          return { error: "sem_token" };
        }
        const usuario = await adminRepo.validarSessao(token);
        if (!usuario) {
          reply.code(401);
          return { error: "sessao_invalida" };
        }
        return usuario;
      });

      instance.post<{ Body: { token?: string } }>("/auth/logout", async (request) => {
        if (request.body?.token) await adminRepo.encerrarSessao(request.body.token);
        return { ok: true };
      });

      instance.get("/users", async () => adminRepo.listarUsuarios());

      instance.post<{
        Body: { nome?: string; email?: string; senha?: string; role?: "ADMINISTRADOR" | "OPERADOR" | "VISUALIZADOR" };
      }>("/users", async (request, reply) => {
        const { nome, email, senha, role } = request.body ?? {};
        if (!nome || !email || !senha) {
          reply.code(400);
          return { error: "campos_obrigatorios", mensagem: "Nome, e-mail e senha são obrigatórios." };
        }
        try {
          const usuario = await adminRepo.criarUsuario({ nome, email, senha, role: role ?? "OPERADOR" });
          reply.code(201);
          return usuario;
        } catch (error) {
          if (isPrismaUniqueConstraintError(error)) {
            reply.code(409);
            return { error: "email_ja_existe", mensagem: "Já existe um usuário com esse e-mail." };
          }
          throw error;
        }
      });

      instance.patch<{
        Params: { id: string };
        Body: { nome?: string; email?: string; role?: "ADMINISTRADOR" | "OPERADOR" | "VISUALIZADOR"; ativo?: boolean };
      }>("/users/:id", async (request, reply) => {
        try {
          return await adminRepo.atualizarUsuario(request.params.id, request.body ?? {});
        } catch (error) {
          if (isPrismaUniqueConstraintError(error)) {
            reply.code(409);
            return { error: "email_ja_existe", mensagem: "Já existe um usuário com esse e-mail." };
          }
          throw error;
        }
      });

      instance.post<{ Params: { id: string } }>("/users/:id/gerar-senha", async (request) => {
        const senhaTemporaria = await adminRepo.gerarNovaSenhaUsuario(request.params.id);
        return { senhaTemporaria };
      });
    },
    { prefix: "/admin" }
  );
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
