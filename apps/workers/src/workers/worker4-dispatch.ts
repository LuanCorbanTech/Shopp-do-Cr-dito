import type IORedis from "ioredis";
import { logger } from "@plataforma-ofertas/shared";
import {
  nextAttemptDate,
  hasExceededMaxAttempts,
  type DispatchPort,
  type EndpointSnapshot,
} from "@plataforma-ofertas/domain";
import { reserveCapacity, hourWindowKey, dayWindowKey, minuteWindowKey } from "@plataforma-ofertas/queue";

// Worker 4 — Disparo (itens 18-24 do escopo original).
//
// Decisão de implementação (simplificação deliberada vs. o desenho com BullMQ
// sugerido no documento de arquitetura): em vez de fila BullMQ + job por oferta,
// este worker faz polling direto na tabela `offers` filtrando por endpoint_id
// (a "fila por endpoint" do item 22 é simplesmente essa query) e usa o contador
// atômico do Redis (packages/queue/capacity.ts) para impor a capacidade por
// minuto/hora/dia. Isso evita um problema de dupla escrita (Postgres diz
// AGUARDANDO_ENVIO, mas o job BullMQ correspondente pode se perder) e mantém os
// 6 workers com o mesmo formato. BullMQ continua sendo uma evolução possível sem
// mudar o schema.
//
// IMPORTANTE: a capacidade é reservada para o TAMANHO DO LOTE antes de reclamar
// ofertas do banco (reserveCapacity concede "até N" atômico) — checar 1 unidade e
// depois disparar um lote inteiro sem novas checagens (versão anterior) permitia
// ultrapassar a capacidade configurada.

export interface HyperflowDispatcher {
  dispatch(params: {
    offerId: string;
    endpoint: EndpointSnapshot;
    telefone: string;
    payload: Record<string, unknown>;
  }): Promise<{ sucesso: boolean; httpStatus: number | null; request: unknown; respostaBruta: unknown }>;
}

export interface RunDispatchWorkerOnceParams {
  dispatchPort: DispatchPort;
  hyperflowService: HyperflowDispatcher;
  redis: IORedis;
  batchSizePerEndpoint?: number;
  now?: Date;
}

export async function runDispatchWorkerOnce(params: RunDispatchWorkerOnceParams): Promise<number> {
  const { dispatchPort, hyperflowService, redis, batchSizePerEndpoint = 10, now = new Date() } = params;

  const endpoints = await dispatchPort.listActiveEndpoints();
  let totalProcessed = 0;
  for (const endpoint of endpoints) {
    totalProcessed += await processEndpoint(endpoint);
  }
  return totalProcessed;

  async function processEndpoint(endpoint: EndpointSnapshot): Promise<number> {
    const granted = await reserveEndpointCapacity(redis, endpoint, batchSizePerEndpoint, now);
    if (granted <= 0) {
      logger.info({ endpointId: endpoint.id }, "Capacidade do endpoint esgotada nesta janela — aguardando");
      return 0;
    }

    const offers = await dispatchPort.claimOffersForDispatch(endpoint.id, granted);
    const unusedCapacity = granted - offers.length;
    if (unusedCapacity > 0) {
      // Capacidade concedida mas sem ofertas suficientes na fila deste endpoint —
      // devolve a sobra para não "gastar" capacidade que não foi realmente usada.
      await releaseEndpointCapacity(redis, endpoint, unusedCapacity, now);
    }

    for (const offer of offers) {
      const telefone = offer.telefoneValidado ?? offer.telefoneAtualizado ?? offer.telefoneOriginal;

      // Defensivo: a essa altura do pipeline (Worker 4) sempre deveria existir um
      // telefone — o Worker 2 já cancela qualquer oferta que chegue sem nenhum
      // telefone disponível (ver worker2-whatsapp.ts) antes dela avançar até aqui.
      // Se ainda assim isso acontecer (bug em outro lugar do pipeline), falha de
      // forma explícita em vez de mandar um telefone vazio pro Hyperflow.
      if (!telefone) {
        const tentativaSemTelefone = offer.tentativasEnvio + 1;
        await dispatchPort.markDispatchFailed(offer.id, {
          endpointId: endpoint.id,
          request: null,
          response: null,
          httpStatus: null,
          erro: "Oferta sem nenhum telefone disponível chegou ao disparo — isso não deveria acontecer.",
          tentativa: tentativaSemTelefone,
          proximaTentativaEm: null,
          cancelar: true,
        });
        logger.error({ offerId: offer.id }, "Disparo cancelado: oferta chegou ao Worker 4 sem telefone");
        totalProcessed += 1;
        continue;
      }

      const tentativa = offer.tentativasEnvio + 1;
      const result = await hyperflowService.dispatch({
        offerId: offer.id,
        endpoint,
        telefone,
        payload: {
          externalId: offer.externalId,
          bancoAutorizado: offer.bancoAutorizado,
          produto: offer.produto,
          valor: offer.valor,
          parcelas: offer.parcelas,
        },
      });

      if (result.sucesso) {
        await dispatchPort.markDispatched(offer.id, {
          endpointId: endpoint.id,
          request: result.request,
          response: result.respostaBruta,
          httpStatus: result.httpStatus,
          tentativa,
        });
      } else {
        const cancelar = hasExceededMaxAttempts(tentativa, endpoint.maxTentativas);
        await dispatchPort.markDispatchFailed(offer.id, {
          endpointId: endpoint.id,
          request: result.request,
          response: result.respostaBruta,
          httpStatus: result.httpStatus,
          erro: `Hyperflow/endpoint respondeu httpStatus=${result.httpStatus}`,
          tentativa,
          proximaTentativaEm: cancelar ? null : nextAttemptDate(tentativa, now),
          cancelar,
        });
        logger.warn({ offerId: offer.id, endpointId: endpoint.id, tentativa, cancelar }, "Falha no disparo");
      }
    }
    return offers.length;
  }
}

function endpointWindowKeys(endpoint: EndpointSnapshot, now: Date): Array<{ key: string; limit: number; ttl: number }> {
  const windows: Array<{ key: string; limit: number; ttl: number }> = [
    { key: hourWindowKey(endpoint.id, now), limit: endpoint.capacidadeHora, ttl: 3600 },
  ];
  if (endpoint.capacidadeMinuto != null) {
    windows.push({ key: minuteWindowKey(endpoint.id, now), limit: endpoint.capacidadeMinuto, ttl: 60 });
  }
  if (endpoint.capacidadeDia != null) {
    windows.push({ key: dayWindowKey(endpoint.id, now), limit: endpoint.capacidadeDia, ttl: 86400 });
  }
  return windows;
}

/** Reserva atomicamente, em cascata, contra todas as janelas configuradas (hora
 * sempre; minuto/dia se configurados) — o resultado é o mínimo concedido entre
 * elas, devolvendo o excedente já reservado nas janelas mais permissivas quando uma
 * janela mais restritiva concede menos. */
async function reserveEndpointCapacity(
  redis: IORedis,
  endpoint: EndpointSnapshot,
  want: number,
  now: Date
): Promise<number> {
  const windows = endpointWindowKeys(endpoint, now);
  let granted = want;
  const touchedKeys: string[] = [];

  for (const window of windows) {
    const before = granted;
    granted = await reserveCapacity(redis, window.key, window.limit, window.ttl, granted);
    if (granted < before && touchedKeys.length > 0) {
      await Promise.all(touchedKeys.map((key) => redis.decrby(key, before - granted)));
    }
    touchedKeys.push(window.key);
  }

  return granted;
}

async function releaseEndpointCapacity(
  redis: IORedis,
  endpoint: EndpointSnapshot,
  amount: number,
  now: Date
): Promise<void> {
  const windows = endpointWindowKeys(endpoint, now);
  await Promise.all(windows.map((window) => redis.decrby(window.key, amount)));
}
