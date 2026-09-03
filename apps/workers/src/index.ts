import IORedis from "ioredis";
import { logger } from "@plataforma-ofertas/shared";
import { prisma, PrismaPipelineRepository, AdminRepository } from "@plataforma-ofertas/database";
import { inicioDoDiaEmBrasilia } from "@plataforma-ofertas/domain";
import { createLimitService } from "@plataforma-ofertas/integration-limit";
import { createWhatsAppValidationService } from "@plataforma-ofertas/integration-whatsapp";
import { createHyperflowService } from "@plataforma-ofertas/integration-hyperflow";
import { runLimitWorkerOnce } from "./workers/worker1-limit";
import { runWhatsappWorkerOnce } from "./workers/worker2-whatsapp";
import { runDispatchWorkerOnce } from "./workers/worker4-dispatch";
import { runRetryWorkerOnce } from "./workers/worker5-retry";
import { runReconciliationWorkerOnce } from "./workers/worker6-reconciliation";
import { runRelatorioPeriodicoWorkerOnce } from "./workers/worker7-relatorio-periodico";
import { runDisparoIndividualWorkerOnce, type DisparoIndividualEndpoint } from "./workers/worker8-disparo-individual";
import { runTarefasWorkerOnce } from "./workers/worker9-tarefas";
import { definirAtivoOdysseia } from "./fornecedores/odysseia";

// Entry point dos 6 workers do pipeline (seção 6.1 do doc de arquitetura). Cada um é
// um polling loop simples (setInterval) — roda tudo em um único processo Node por
// padrão; em produção, cada `startX` pode virar seu próprio processo/container
// (o schema/domínio já é o mesmo, só muda como este arquivo é dividido).

const repo = new PrismaPipelineRepository(prisma);
const adminRepo = new AdminRepository(prisma);
const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

// Credenciais da Lemit e da CorbanTech (WhatsApp) agora são editáveis no painel
// ("Integrações") em vez de fixas no .env — ficam salvas em integration_configs e são
// lidas do banco A CADA CICLO do worker (nunca uma vez só no arranque), então trocar a
// chave no painel vale no ciclo seguinte, sem reiniciar container. O .env continua
// funcionando como fallback (ex.: ambiente local sem painel configurado ainda). Se
// nenhuma das duas fontes tiver valor, a consulta daquele item falha e entra no fluxo
// normal de retry/backoff — não derruba o worker inteiro como antes.

async function resolverCredenciaisLemit(): Promise<{ apiKey: string; baseUrl?: string; urlConsulta?: string }> {
  const config = await prisma.integrationConfig.findUnique({ where: { chave: "LEMIT_CREDENCIAIS" } });
  const valor = (config?.valor ?? {}) as { apiKey?: string; baseUrl?: string; urlConsulta?: string };
  const apiKey = valor.apiKey || process.env.LIMIT_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Credenciais da Lemit não configuradas (painel Integrações, ou LIMIT_API_KEY no .env como alternativa)"
    );
  }
  return {
    apiKey,
    baseUrl: valor.baseUrl || process.env.LIMIT_API_BASE_URL || undefined,
    // Editável no painel (03/09) — se preenchida, o pacote de integração usa
    // ela direto, ignorando baseUrl + o caminho padrão embutido no código.
    urlConsulta: valor.urlConsulta || process.env.LIMIT_API_URL_CONSULTA || undefined,
  };
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
      tempoMaximoEsperaLoteMinutos?: number;
    };
    return {
      loteMinimo: typeof valor.loteMinimo === "number" && valor.loteMinimo > 0 ? valor.loteMinimo : padroes.loteMinimo,
      loteMaximo: typeof valor.loteMaximo === "number" && valor.loteMaximo > 0 ? valor.loteMaximo : padroes.loteMaximo,
      tempoMaximoEsperaLoteMs:
        typeof valor.tempoMaximoEsperaLoteMinutos === "number" && valor.tempoMaximoEsperaLoteMinutos > 0
          ? valor.tempoMaximoEsperaLoteMinutos * 60 * 1000
          : padroes.tempoMaximoEsperaLoteMs,
    };
  } catch (error) {
    logger.warn({ error }, "Falha ao ler parâmetros de lote configurados no painel — usando os padrões");
    return padroes;
  }
}

// Config do worker7 (relatório periódico) — mesmo padrão dos resolvers acima:
// lida do banco a cada ciclo, então trocar o endpoint/frequência no painel
// ("Integrações") vale a partir do ciclo seguinte, sem reiniciar nada. Ao
// contrário das outras integrações, aqui o intervalo é em HORAS (o usuário pediu
// algo como "de 4 em 4 horas"), não segundos.
async function resolverConfigRelatorioPeriodico(): Promise<{
  ativo: boolean;
  endpointUrl: string | null;
  horaInicio: string | null;
  horaFim: string | null;
}> {
  try {
    const config = await prisma.integrationConfig.findUnique({ where: { chave: "RELATORIO_PERIODICO_WEBHOOK" } });
    const valor = (config?.valor ?? {}) as { endpointUrl?: string; horaInicio?: string; horaFim?: string };
    return {
      ativo: config?.ativo ?? false,
      endpointUrl: valor.endpointUrl || null,
      // Janela de horário permitida pro envio (ex.: "08:00" a "20:00", pra não
      // mandar de madrugada) — sem os dois, o worker envia a qualquer hora.
      horaInicio: valor.horaInicio || null,
      horaFim: valor.horaFim || null,
    };
  } catch (error) {
    logger.warn({ error }, "Falha ao ler a config do relatório periódico — ciclo será ignorado");
    return { ativo: false, endpointUrl: null, horaInicio: null, horaFim: null };
  }
}

async function resolverIntervaloRelatorioPeriodicoMs(padraoMs: number): Promise<number> {
  try {
    const config = await prisma.integrationConfig.findUnique({ where: { chave: "RELATORIO_PERIODICO_WEBHOOK" } });
    const valor = (config?.valor ?? {}) as { intervaloHoras?: number };
    if (typeof valor.intervaloHoras === "number" && valor.intervaloHoras > 0) {
      return valor.intervaloHoras * 60 * 60 * 1000;
    }
  } catch (error) {
    logger.warn({ error }, "Falha ao ler o intervalo do relatório periódico — usando o padrão");
  }
  return padraoMs;
}

// Config do worker8 (disparo individual, push) — mesmo padrão dos resolvers
// acima: lida do banco a cada ciclo, então trocar endpoint/frequência/
// ativar/desativar no painel ("Integrações") vale a partir do ciclo
// seguinte, sem reiniciar nada. Intervalo em SEGUNDOS (não horas) — o
// pedido foi "um temporizador", pensado pra rodar com frequência.
async function resolverConfigDisparoIndividual(): Promise<{
  ativo: boolean;
  endpoints: DisparoIndividualEndpoint[];
  ararahqApiKey: string | null;
}> {
  try {
    const config = await prisma.integrationConfig.findUnique({ where: { chave: "DISPARO_INDIVIDUAL_WEBHOOK" } });
    const valor = (config?.valor ?? {}) as {
      endpointUrl?: string;
      endpoints?: Array<Partial<DisparoIndividualEndpoint> & { id: string; url: string; ativo: boolean }>;
      ararahqApiKey?: string;
    };
    // Migração automática, em 2 camadas, só na LEITURA (sem precisar de
    // nenhum passo manual):
    // 1) formato bem antigo (1 endpoint só, campo "endpointUrl") vira lista;
    // 2) qualquer endpoint (antigo ou já em lista, de antes do campo
    //    "modelo" existir) que não tenha "modelo" definido vira "hyperflow"
    //    — era o único formato que existia antes desse campo ser criado.
    let endpointsBrutos = valor.endpoints;
    if ((!endpointsBrutos || endpointsBrutos.length === 0) && valor.endpointUrl) {
      endpointsBrutos = [{ id: "migrado-automatico", url: valor.endpointUrl, ativo: true }];
    }
    const endpoints: DisparoIndividualEndpoint[] = (endpointsBrutos ?? []).map((e) => ({
      id: e.id,
      url: e.url,
      ativo: e.ativo,
      modelo: e.modelo === "ararahq" ? "ararahq" : "hyperflow",
    }));
    return {
      ativo: config?.ativo ?? false,
      endpoints,
      ararahqApiKey: valor.ararahqApiKey || null,
    };
  } catch (error) {
    logger.warn({ error }, "Falha ao ler a config do disparo individual — ciclo será ignorado");
    return { ativo: false, endpoints: [], ararahqApiKey: null };
  }
}

async function resolverIntervaloDisparoIndividualMs(padraoMs: number): Promise<number> {
  try {
    const config = await prisma.integrationConfig.findUnique({ where: { chave: "DISPARO_INDIVIDUAL_WEBHOOK" } });
    const valor = (config?.valor ?? {}) as { intervaloSegundos?: number };
    if (typeof valor.intervaloSegundos === "number" && valor.intervaloSegundos > 0) {
      return valor.intervaloSegundos * 1000;
    }
  } catch (error) {
    logger.warn({ error }, "Falha ao ler o intervalo do disparo individual — usando o padrão");
  }
  return padraoMs;
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

// Worker7 — relatório periódico (nova integração, painel "Integrações"): envia por
// POST as contagens de HOJE (em Brasília) pro endpoint que o usuário cadastrar, na
// frequência que ele configurar (ex.: de 4 em 4 horas — WORKER7_INTERVAL_MS só serve
// de padrão de fallback antes de qualquer configuração salva no painel). O guard
// "!ativo" evita calcular os KPIs à toa quando a integração está desligada.
const WORKER7_INTERVAL_MS_PADRAO = Number(process.env.WORKER7_INTERVAL_MS ?? 4 * 60 * 60 * 1000);

loop(
  "worker7-relatorio-periodico",
  WORKER7_INTERVAL_MS_PADRAO,
  async () => {
    const { ativo, endpointUrl, horaInicio, horaFim } = await resolverConfigRelatorioPeriodico();
    if (!ativo) return 0;
    const kpis = await adminRepo.dashboardKpis({ from: inicioDoDiaEmBrasilia(), to: new Date() });
    return runRelatorioPeriodicoWorkerOnce({ ativo, endpointUrl, horaInicio, horaFim, kpis });
  },
  () => resolverIntervaloRelatorioPeriodicoMs(WORKER7_INTERVAL_MS_PADRAO)
);

// Worker8 — disparo individual (push, painel "Integrações"): a cada ciclo,
// pega no máximo 1 lead aguardando disparo (reaproveita a mesma claim
// atômica do GET /api/v1/leads/aguardando-disparo) e manda pro endpoint
// cadastrado — nunca todos de uma vez, sempre 1 por ciclo (pedido
// explícito). Intervalo padrão de fallback: 30s (antes de qualquer
// configuração salva no painel).
const WORKER8_INTERVAL_MS_PADRAO = Number(process.env.WORKER8_INTERVAL_MS ?? 30_000);

loop(
  "worker8-disparo-individual",
  WORKER8_INTERVAL_MS_PADRAO,
  async () => {
    const { ativo, endpoints, ararahqApiKey } = await resolverConfigDisparoIndividual();
    return runDisparoIndividualWorkerOnce({ ativo, endpoints, ararahqApiKey, port: repo });
  },
  () => resolverIntervaloDisparoIndividualMs(WORKER8_INTERVAL_MS_PADRAO)
);

// Worker9 — tarefas de recebimento (31/08): a cada ciclo, checa as tarefas
// agendadas de cada webhook — liga o fornecedor quando chega a hora,
// desliga quando bate a meta de ofertas. Roda a cada 30s por padrão (não
// precisa ser tão frequente quanto os outros, é só liga/desliga por
// data/hora e contagem).
const WORKER9_INTERVAL_MS = Number(process.env.WORKER9_INTERVAL_MS ?? 30_000);

loop("worker9-tarefas", WORKER9_INTERVAL_MS, async () => {
  const resultado = await runTarefasWorkerOnce({
    port: adminRepo,
    ativadores: {
      odysseia: definirAtivoOdysseia,
    },
  });
  return resultado.iniciadas + resultado.concluidas;
});

process.on("SIGTERM", async () => {
  logger.info("Encerrando workers...");
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
});
