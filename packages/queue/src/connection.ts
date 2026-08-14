import IORedis from "ioredis";

// Conexão Redis compartilhada por todas as filas BullMQ (ver seção 6 do doc de arquitetura).
// TODO (Fase 5): criar uma fila por endpoint dinamicamente ("dispatch:{endpointId}")
// a partir dos endpoints cadastrados no painel.
export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new IORedis(url, { maxRetriesPerRequest: null });
}
