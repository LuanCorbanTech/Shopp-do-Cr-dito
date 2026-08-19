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
  async startCheckLote(params: Parameters<ReturnType<typeof createWhatsAppValidationService>["startCheckLote"]>[0]) {
    const credenciais = await resolverCredenciaisWhatsapp();
    return createWhatsAppValidationService(credenciais).startCheckLote(params);
  },
  async getCheckResultLote(loteId: string) {
    const credenciais = await resolverCredenciaisWhatsapp();
    return createWhatsAppValidationService(credenciais).getCheckResultLote(loteId);
  },
};

// Intervalo em segundos configurável no painel ("Integrações"), salvo junto
// com a credencial de cada serviço (mesmo card, mesmo JSON em
// integration_configs) — lido do banco A CADA CICLO, igual as credenciais.
// Fallback pro valor do .env (WORKER1_INTERVAL_MS/WORKER2_INTERVAL_MS) se
// ainda não foi configurado no painel, ou se a leitura falhar por algum
// motivo (nunca deixa o worker travado por causa disso).
async function resolverIntervaloMs(
  chave: "LEMIT_CREDENCIAIS" | "WHATSAPP_VALIDACAO_CREDENCIAIS",
  envDefaultMs: number
): Promise<number> {
  try {
    const config = await prisma.integrationConfig.findUnique({ where: { chave } });
    const valor = (config?.valor ?? {}) as { intervaloSegundos?: number };
    if (typeof valor.intervaloSegundos === "number" && valor.intervaloSegundos > 0) {
      return valor.intervaloSegundos * 1000;
    }
  } catch (error) {
    logger.warn({ chave, error }, "Falha ao ler intervalo configurado no painel — usando o padrão do .env");
  }
  return envDefaultMs;
}

// Mesmo padrão do "resolverIntervaloMs" acima, mas pro limite de requisições
// por ciclo (rate limit da API externa, configurável no painel
// "Integrações") — lido do banco A CADA CICLO, então trocar o valor no
// painel vale a partir do próximo ciclo, sem reiniciar o worker. Isso é o
// que faz o worker NUNCA processar mais que esse número de itens por vez —
// o excedente simplesmente fica pra trás (nem é "puxado" da fila ainda),
// aguardando o próximo ciclo automaticamente (o claim usa SKIP LOCKED com
// limite, então não precisa de nenhuma fila separada pra isso).
async function resolverBatchSize(
  chave: "LEMIT_CREDENCIAIS" | "WHATSAPP_VALIDACAO_CREDENCIAIS",
  padrao: number
): Promise<number> {
  try {
    const config = await prisma.integrationConfig.findUnique({ where: { chave } });
    const valor = (config?.valor ?? {}) as { limiteRequisicoesPorCiclo?: number };
    if (typeof valor.limiteRequisicoesPorCiclo === "number" && valor.limiteRequisicoesPorCiclo > 0) {
      return valor.limiteRequisicoesPorCiclo;
    }
  } catch (error) {
    logger.warn({ chave, error }, "Falha ao ler limite de requisições configurado no painel — usando o padrão");
  }
  return padrao;
}

// Mesmo padrão acima, mas pros 3 parâmetros do lote de WhatsApp (checknumber.ai,
// mínimo real do fornecedor: 500) — configuráveis no painel Integrações,
// lidos de novo a cada ciclo do worker (troca no painel vale a partir do
// próximo ciclo, sem reiniciar nada).
async function resolverParametrosLote(padroes: {
  loteMinimo: number;
  loteMaximo: number;
  tempoMaximoEsperaLoteMs: number;
}): Promise<{ loteMinimo: number; loteMaximo: number; tempoMaximoEsperaLoteMs: number }> {
  try {
    const config = await prisma.integrationConfig.findUnique({ where: { chave: "WHATSAPP_VALIDACAO_CREDENCIAIS" } });
    const valor = (config?.valor ?? {}) as {
      loteMinimo?: number;
      loteMaximo?: number;
      tempoMaximoEsperaLoteHoras?: number;
    };
    return {
      loteMinimo: typeof valor.loteMinimo === "number" && valor.loteMinimo > 0 ? valor.loteMinimo : padroes.loteMinimo,
      loteMaximo: typeof valor.loteMaximo === "number" && valor.loteMaximo > 0 ? valor.loteMaximo : padroes.loteMaximo,
      tempoMaximoEsperaLoteMs:
        typeof valor.tempoMaximoEsperaLoteHoras === "number" && valor.tempoMaximoEsperaLoteHoras > 0
          ? valor.tempoMaximoEsperaLoteHoras * 60 * 60 * 1000
          : padroes.tempoMaximoEsperaLoteMs,
    };
  } catch (error) {
    logger.warn({ error }, "Falha ao ler parâmetros de lote configurados no painel — usando os padrões");
    return padroes;
  }
}

const hyperflowService = createHyperflowService();

// "resolverIntervalo" (opcional): quando informado, o próximo ciclo é
// agendado com o valor que ele devolver (consultado de novo a cada ciclo) —
// em vez de setInterval (que fixa o intervalo uma vez só no arranque e não
// dá pra mudar depois sem reiniciar o processo), usa setTimeout recursivo:
// só agenda o próximo ciclo depois que o atual termina, e pode reconsultar o
// intervalo desejado a cada vez.
function loop(
  name: string,
  intervalMsPadrao: number,
  run: () => Promise<number>,
  resolverIntervalo?: () => Promise<number>
): void {
  let running = false;

  async function tick() {
    if (running) {
      // Ciclo anterior ainda rodando (raro) — tenta de novo em breve, sem
      // empilhar execuções concorrentes.
      setTimeout(tick, intervalMsPadrao);
      return;
    }
    running = true;
    try {
      const count = await run();
      if (count > 0) logger.info({ worker: name, processadas: count }, "Ciclo do worker concluído");
    } catch (error) {
      logger.error({ worker: name, error }, "Erro não tratado no ciclo do worker");
    } finally {
      running = false;
      const proximoIntervalo = resolverIntervalo ? await resolverIntervalo().catch(() => intervalMsPadrao) : intervalMsPadrao;
      setTimeout(tick, proximoIntervalo);
    }
  }

  logger.info({ worker: name, intervalMsPadrao }, "Worker iniciado");
  setTimeout(tick, intervalMsPadrao);
}

const WORKER1_INTERVAL_MS_PADRAO = Number(process.env.WORKER1_INTERVAL_MS ?? 5000);
const WORKER2_INTERVAL_MS_PADRAO = Number(process.env.WORKER2_INTERVAL_MS ?? 5000);

loop(
  "worker1-limit",
  WORKER1_INTERVAL_MS_PADRAO,
  async () => {
    const batchSize = await resolverBatchSize("LEMIT_CREDENCIAIS", 20);
    return runLimitWorkerOnce({ phonePort: repo, configPort: repo, limitService, batchSize });
  },
  () => resolverIntervaloMs("LEMIT_CREDENCIAIS", WORKER1_INTERVAL_MS_PADRAO)
);

loop(
  "worker2-whatsapp",
  WORKER2_INTERVAL_MS_PADRAO,
  async () => {
    const batchSize = await resolverBatchSize("WHATSAPP_VALIDACAO_CREDENCIAIS", 20);
    const { loteMinimo, loteMaximo, tempoMaximoEsperaLoteMs } = await resolverParametrosLote({
      loteMinimo: 500,
      loteMaximo: 5000,
      tempoMaximoEsperaLoteMs: 2 * 60 * 60 * 1000,
    });
    return runWhatsappWorkerOnce({
      whatsappPort: repo,
      configPort: repo,
      whatsappService,
      batchSize,
      loteMinimo,
      loteMaximo,
      tempoMaximoEsperaLoteMs,
    });
  },
  () => resolverIntervaloMs("WHATSAPP_VALIDACAO_CREDENCIAIS", WORKER2_INTERVAL_MS_PADRAO)
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
