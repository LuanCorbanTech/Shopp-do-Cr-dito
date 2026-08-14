import { Registry, Gauge } from "prom-client";
import type { PrismaClient } from "@prisma/client";

// Métricas mínimas (seção 42 do escopo original / seção 10 do doc de arquitetura):
// ofertas por status é o indicador mais útil de saúde do pipeline (fila crescendo em
// AGUARDANDO_*, acúmulo em ERRO_*, SEM_ROTA_CONFIGURADA subindo etc.). Métricas mais
// finas (latência por integração externa, throughput por endpoint) ficam para quando
// houver tráfego real para medir — este endpoint já dá a base para alertas simples.
const registry = new Registry();

const offersByStatus = new Gauge({
  name: "ofertas_por_status",
  help: "Quantidade de ofertas por status no momento da coleta",
  labelNames: ["status"],
  registers: [registry],
});

export async function collectMetrics(prisma: PrismaClient): Promise<{ contentType: string; body: string }> {
  const rows = await prisma.offer.groupBy({ by: ["status"], _count: { _all: true } });
  offersByStatus.reset();
  for (const row of rows) {
    offersByStatus.set({ status: row.status }, row._count._all);
  }
  const body = await registry.metrics();
  return { contentType: registry.contentType, body };
}
