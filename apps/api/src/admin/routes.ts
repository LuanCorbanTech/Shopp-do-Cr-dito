import type { FastifyInstance } from "fastify";
import type { AdminRepository } from "@plataforma-ofertas/database";
import { requireAdminAuth } from "./auth";

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
