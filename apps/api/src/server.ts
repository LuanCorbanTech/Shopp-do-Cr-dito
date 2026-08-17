import Fastify from "fastify";
import { logger } from "@plataforma-ofertas/shared";
import { prisma, PrismaOffersPort, PrismaPipelineRepository, AdminRepository } from "@plataforma-ofertas/database";
import { registerRawBodyParser } from "./plugins/raw-body";
import { registerWebhookRoutes } from "./webhooks/routes";
import { registerWhatsappValidacaoWebhookRoutes } from "./webhooks/whatsapp-validacao-routes";
import { registerAdminRoutes } from "./admin/routes";
import { registerAguardandoDisparoRoutes } from "./leads/aguardando-disparo-routes";
import { collectMetrics } from "./observability/metrics";

const app = Fastify({ logger: false });

registerRawBodyParser(app);

const offersPort = new PrismaOffersPort(prisma);
const pipelineRepo = new PrismaPipelineRepository(prisma);
const adminRepo = new AdminRepository(prisma);
const toleranceSeconds = Number(process.env.WEBHOOK_HMAC_DEFAULT_TOLERANCE_SECONDS ?? 300);

const whatsappWebhookToken = process.env.WHATSAPP_WEBHOOK_TOKEN;
if (!whatsappWebhookToken) {
  throw new Error("WHATSAPP_WEBHOOK_TOKEN não configurada (obrigatória — ver docs/integrations)");
}

// DISPATCH_API_TOKEN — diferente de WHATSAPP_WEBHOOK_TOKEN acima, essa NÃO
// derruba o servidor se faltar (endpoint novo, ainda em configuração do lado
// do disparador de WhatsApp externo): a rota simplesmente responde 503 até
// alguém configurar a variável, sem crashar o processo inteiro por causa
// disso — ver aguardando-disparo-routes.ts.
const dispatchApiToken = process.env.DISPATCH_API_TOKEN;
if (!dispatchApiToken) {
  logger.warn(
    "DISPATCH_API_TOKEN não configurada — GET /api/v1/leads/aguardando-disparo vai responder 503 até isso ser definido."
  );
}

registerWebhookRoutes(app, offersPort, toleranceSeconds);
registerWhatsappValidacaoWebhookRoutes(app, pipelineRepo, pipelineRepo, whatsappWebhookToken);
registerAdminRoutes(app, adminRepo);
registerAguardandoDisparoRoutes(app, pipelineRepo, dispatchApiToken);

app.get("/health", async () => ({ status: "ok" }));

app.get("/metrics", async (_request, reply) => {
  const { contentType, body } = await collectMetrics(prisma);
  reply.header("Content-Type", contentType).send(body);
});

const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? "0.0.0.0";

app
  .listen({ port, host })
  .then(() => logger.info(`API ouvindo em http://${host}:${port}`))
  .catch((err) => {
    logger.error(err, "Falha ao iniciar a API");
    process.exit(1);
  });
