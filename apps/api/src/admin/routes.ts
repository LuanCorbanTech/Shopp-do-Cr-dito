import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AdminRepository } from "@plataforma-ofertas/database";
import { requireAdminAuth } from "./auth";

const ESQUEMAS_ASSINATURA_VALIDOS = ["ofertas_v1", "hmac_sha256_simple"];

// API do painel administrativo (seção 8 do doc de arquitetura / itens 31-38 do
// escopo original): dashboard, toggle do Limit, CRUD de endpoints e regras de
// roteamento, listagem/detalhe/timeline de ofertas. Tudo sob /admin, protegido por
// requireAdminAuth.
export function registerAdminRoutes(app: FastifyInstance, adminRepo: AdminRepository): void {
  app.register(
    async (instance) => {
      instance.addHook("onRequest", requireAdminAuth);

      instance.get("/dashboard", async () => adminRepo.dashboardSummary());
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
        Body: { integracao?: string; apiKey?: string; baseUrl?: string };
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
        await adminRepo.salvarCredenciaisIntegracao(chave, { apiKey: body.apiKey, baseUrl: body.baseUrl });
        const atualizado = await adminRepo.getCredenciaisIntegracoes();
        return atualizado[body.integracao as "lemit" | "whatsapp"];
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

      instance.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
        "/offers",
        async (request) => {
          const limit = Math.min(Number(request.query.limit ?? 50) || 50, 200);
          const offset = Math.max(Number(request.query.offset ?? 0) || 0, 0);
          return adminRepo.listOffers({ status: request.query.status, limit, offset });
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
    },
    { prefix: "/admin" }
  );
}
