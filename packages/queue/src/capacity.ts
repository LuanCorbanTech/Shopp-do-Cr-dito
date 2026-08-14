import type IORedis from "ioredis";

// Contador atômico de capacidade por endpoint e janela de tempo (seção 6.3/6.4 do doc
// de arquitetura). Usado pelo Worker 4 como camada de rate limiting independente da
// contagem no Postgres — resiliente a múltiplas instâncias do worker rodando ao mesmo
// tempo, porque o INCR do Redis é atômico mesmo sob concorrência real (validado
// manualmente: 20 chamadas paralelas com limite 10 resultam em exatamente 10 aceitas).
export interface CapacityCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
}

export async function checkAndIncrementCapacity(
  redis: IORedis,
  key: string,
  limit: number,
  ttlSeconds: number
): Promise<CapacityCheckResult> {
  const granted = await reserveCapacity(redis, key, limit, ttlSeconds, 1);
  const current = Number((await redis.get(key)) ?? 0);
  return { allowed: granted === 1, current, limit };
}

/**
 * Reserva atomicamente até `want` unidades de capacidade numa janela (INCRBY seguido
 * de correção se ultrapassar o limite). Retorna quantas unidades foram de fato
 * concedidas (0 <= concedido <= want) — permite ao chamador processar só o que cabe
 * na janela, em vez de checar 1 unidade e depois processar um lote inteiro (esse era
 * exatamente o bug do Worker 4 antes desta função existir: capacidade verificada uma
 * vez, lote inteiro disparado). Testado sob concorrência real com múltiplas chamadas
 * paralelas — ver capacity.test.ts.
 */
export async function reserveCapacity(
  redis: IORedis,
  key: string,
  limit: number,
  ttlSeconds: number,
  want: number
): Promise<number> {
  if (want <= 0) return 0;
  const newTotal = await redis.incrby(key, want);
  const previousTotal = newTotal - want;
  if (previousTotal === 0) {
    await redis.expire(key, ttlSeconds);
  }
  if (newTotal <= limit) {
    return want;
  }
  const allowed = Math.max(0, limit - previousTotal);
  const excess = want - allowed;
  if (excess > 0) {
    await redis.decrby(key, excess);
  }
  return allowed;
}

export function hourWindowKey(endpointId: string, now: Date = new Date()): string {
  const label = now.toISOString().slice(0, 13).replace(/[-T:]/g, ""); // yyyyMMddHH
  return `endpoint:${endpointId}:hora:${label}`;
}

export function dayWindowKey(endpointId: string, now: Date = new Date()): string {
  const label = now.toISOString().slice(0, 10).replace(/-/g, ""); // yyyyMMdd
  return `endpoint:${endpointId}:dia:${label}`;
}

export function minuteWindowKey(endpointId: string, now: Date = new Date()): string {
  const label = now.toISOString().slice(0, 16).replace(/[-T:]/g, ""); // yyyyMMddHHmm
  return `endpoint:${endpointId}:min:${label}`;
}
