import IORedis from "ioredis";
import { logger } from "@plataforma-ofertas/shared";
import { prisma, PrismaPipelineRepository } from "@plataforma-ofertas/database";
import { createLimitService } from "@plataforma-ofertas/integration-limit";
import { createWhatsAppValidationService } from "@plataforma-ofertas/integration-whatsapp";
import { createHyperflowService } from "@plataforma-ofertas/integration-hyperflow";
import { runLimitWorkerOnce } from "./workers/worker1-limit";
import { runWhatsappWorkerOnce } from "./workers/worker2-whatsapp";
import { runDispatchWorkerOnce } from "./workers/worker4-dispatch";
import { runRetryWorkerOnce } from "./workers/worker5-retry";
import { runReconciliationWorkerOnce } from "./workers/worker6-reconciliation";

// Entry point dos 6 workers do pipeline (seção 6.1 do doc de arquitetura). Cada um é
// um polling loop simples (setInterval) — roda tudo em um único processo Node por
// padrão; em produção, cada `startX` pode virar seu próprio processo/container
// (o schema/domínio já é o mesmo, só muda como este arquivo é dividido).

const repo = new PrismaPipelineRepository(prisma);
const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

// Credenciais da Lemit e da CorbanTech (WhatsApp) agora são editáveis no painel
// ("Integrações") em vez de fixas no .env — ficam salvas em integration_configs e são
// lidas do banco A CADA CICLO do worker (nunca uma vez só no arranque), então trocar a
// chave no painel vale no ciclo seguinte, sem reiniciar container. O .env continua
// funcionando como fallback (ex.: ambiente local sem painel configurado ainda). Se
// nenhuma das duas fontes tiver valor, a consulta daquele item falha e entra no fluxo
// normal de retry/backoff — não derruba o worker inteiro como antes.

async function resolverCredenciaisLemit(): Promise<{ apiKey: string; baseUrl?: string }> {
  const config = await prisma.integrationConfig.findUnique({ where: { chave: "LEMIT_CREDENCIAIS" } });
  const valor = (config?.valor ?? {}) as { apiKey?: string; baseUrl?: string };
  const apiKey = valor.apiKey || process.env.LIMIT_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Credenciais da Lemit não configuradas (painel Integrações, ou LIMIT_API_KEY no .env como alternativa)"
    );
  }
  return { apiKey, baseUrl: valor.baseUrl || process.env.LIMIT_API_BASE_URL || undefined };
}

async function resolverCredenciaisWhatsapp(): Promise<{ apiKey: string; baseUrl: string }> {
  const config = await prisma.integrationConfig.findUnique({ where: { chave: "WHATSAPP_VALIDACAO_CREDENCIAIS" } });
  const valor = (config?.valor ?? {}) as { apiKey?: string; baseUrl?: string };
  const apiKey = valor.apiKey || process.env.WHATSAPP_VALIDATION_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Credenciais da CorbanTech (WhatsApp) não configuradas (painel Integrações, ou WHATSAPP_VALIDATION_API_KEY no .env como alternativa)"
    );
  }
  return { apiKey, baseUrl: valor.baseUrl || process.env.WHATSAPP_VALIDATION_API_BASE_URL || "http://localhost:9902" };
}

const limitService = {
  async lookupPhone(params: { documento: string }) {
    const credenciais = await resolverCredenciaisLemit();
    return createLimitService(credenciais).lookupPhone(params);
  },
};

const whatsappService = {
  async startCheck(params: Parameters<ReturnType<typeof createWhatsAppValidationService>["startCheck"]>[0]) {
    const credenciais = await resolverCredenciaisWhatsapp();
    return createWhatsAppValidationService(credenciais).startCheck(params);
  },
  async getCheckResult(requestId: string) {
    const credenciais = await resolverCredenciaisWhatsapp();
    return createWhatsAppValidationService(credenciais).getCheckResult(requestId);
  },
};

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

// worker3-routing (motor de roteamento interno) parado (17/08) — substituído pelo
// endpoint de disparo por polling externo (GET /api/v1/leads/aguardando-disparo,
// ver apps/api/src/leads/aguardando-disparo-routes.ts). O código do worker
// continua existindo (não foi removido, só desligado aqui), caso um dia volte a
// ser necessário.
//
// loop("worker3-routing", Number(process.env.WORKER3_INTERVAL_MS ?? 5000), () =>
//   runRoutingWorkerOnce({ routingPort: repo })
// );

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
