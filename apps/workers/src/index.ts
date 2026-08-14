import IORedis from "ioredis";
import { logger } from "@plataforma-ofertas/shared";
import { prisma, PrismaPipelineRepository } from "@plataforma-ofertas/database";
import { createLimitService } from "@plataforma-ofertas/integration-limit";
import { createWhatsAppValidationService } from "@plataforma-ofertas/integration-whatsapp";
import { createHyperflowService } from "@plataforma-ofertas/integration-hyperflow";
import { runLimitWorkerOnce } from "./workers/worker1-limit";
import { runWhatsappWorkerOnce } from "./workers/worker2-whatsapp";
import { runRoutingWorkerOnce } from "./workers/worker3-routing";
import { runDispatchWorkerOnce } from "./workers/worker4-dispatch";
import { runRetryWorkerOnce } from "./workers/worker5-retry";
import { runReconciliationWorkerOnce } from "./workers/worker6-reconciliation";

// Entry point dos 6 workers do pipeline (seção 6.1 do doc de arquitetura). Cada um é
// um polling loop simples (setInterval) — roda tudo em um único processo Node por
// padrão; em produção, cada `startX` pode virar seu próprio processo/container
// (o schema/domínio já é o mesmo, só muda como este arquivo é dividido).

const repo = new PrismaPipelineRepository(prisma);
const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

const limitService = createLimitService({
  baseUrl: process.env.LIMIT_API_BASE_URL || "http://localhost:9901",
  apiKey: process.env.LIMIT_API_KEY,
});
const whatsappApiKey = process.env.WHATSAPP_VALIDATION_API_KEY;
if (!whatsappApiKey) {
  throw new Error("WHATSAPP_VALIDATION_API_KEY não configurada (obrigatória — ver docs/integrations)");
}
const whatsappService = createWhatsAppValidationService({
  baseUrl: process.env.WHATSAPP_VALIDATION_API_BASE_URL || "http://localhost:9902",
  apiKey: whatsappApiKey,
});
const hyperflowService = createHyperflowService();

function loop(name: string, intervalMs: number, run: () => Promise<number>): void {
  let running = false;
  setInterval(() => {
    if (running) return; // evita empilhar execuções se uma rodada demorar mais que o intervalo
    running = true;
    run()
      .then((count) => {
        if (count > 0) logger.info({ worker: name, processadas: count }, "Ciclo do worker concluído");
      })
      .catch((error) => logger.error({ worker: name, error }, "Erro não tratado no ciclo do worker"))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  logger.info({ worker: name, intervalMs }, "Worker iniciado");
}

loop("worker1-limit", Number(process.env.WORKER1_INTERVAL_MS ?? 5000), () =>
  runLimitWorkerOnce({ phonePort: repo, configPort: repo, limitService })
);

loop("worker2-whatsapp", Number(process.env.WORKER2_INTERVAL_MS ?? 5000), () =>
  runWhatsappWorkerOnce({ whatsappPort: repo, configPort: repo, whatsappService })
);

loop("worker3-routing", Number(process.env.WORKER3_INTERVAL_MS ?? 5000), () =>
  runRoutingWorkerOnce({ routingPort: repo })
);

loop("worker4-dispatch", Number(process.env.WORKER4_INTERVAL_MS ?? 5000), () =>
  runDispatchWorkerOnce({ dispatchPort: repo, hyperflowService, redis })
);

loop("worker5-retry", Number(process.env.WORKER5_INTERVAL_MS ?? 15000), () =>
  runRetryWorkerOnce({ retryPort: repo })
);

loop("worker6-reconciliation", Number(process.env.WORKER6_INTERVAL_MS ?? 60000), () =>
  runReconciliationWorkerOnce({
    reconciliationPort: repo,
    slaMs: Number(process.env.RECONCILIATION_SLA_MS ?? 10 * 60 * 1000),
  })
);

process.on("SIGTERM", async () => {
  logger.info("Encerrando workers...");
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
});
