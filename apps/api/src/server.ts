import Fastify from "fastify";
import { logger } from "@plataforma-ofertas/shared";
import { prisma, PrismaOffersPort, PrismaPipelineRepository, AdminRepository } from "@plataforma-ofertas/database";
import { registerRawBodyParser } from "./plugins/raw-body";
import { registerWebhookRoutes } from "./webhooks/routes";
import { registerWhatsappValidacaoWebhookRoutes } from "./webhooks/whatsapp-validacao-routes";
import { registerAdminRoutes } from "./admin/routes";
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

registerWebhookRoutes(app, offersPort, toleranceSeconds);
registerWhatsappValidacaoWebhookRoutes(app, pipelineRepo, pipelineRepo, whatsappWebhookToken);
registerAdminRoutes(app, adminRepo);

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
