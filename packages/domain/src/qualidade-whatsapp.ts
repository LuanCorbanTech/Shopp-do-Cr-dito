// Qualidade WhatsApp (10/09) — lógica pura de "isso piorou?", usada pelo
// worker10-qualidade-whatsapp (packages/database, ao gravar cada consulta)
// pra decidir se dispara o webhook de alerta. Fica aqui (não em
// packages/database) pra ser testável sem precisar de Postgres.
//
// Critério combinado (nenhum dos 3 documentado formalmente pela Meta como
// "isso é uma piora" — decisão de produto tomada em 10/09, ajustável depois
// sem migração):
//   1) quality_rating caiu de nível (GREEN > YELLOW > RED, com UNKNOWN entre
//      RED e YELLOW — perder um rating conhecido e virar UNKNOWN também
//      conta como piora, mas começar em UNKNOWN e virar YELLOW/GREEN não).
//   2) messaging_limit_tier caiu de nível — só quando os dois tiers (antes e
//      depois) são reconhecidos; um tier novo/desconhecido nunca gera falso
//      positivo.
//   3) status virou um dos "ruins" (FLAGGED/RESTRICTED/DISCONNECTED/BANNED)
//      e antes não era.
// Um número novo (sem registro anterior) nunca conta como piora.

export interface EstadoQualidadeNumero {
  qualityRating: string | null;
  messagingLimitTier?: string | null;
  status?: string | null;
}

export interface PioraDetectada {
  piorou: boolean;
  motivo: string | null;
}

const ORDEM_QUALIDADE: Record<string, number> = {
  RED: 0,
  UNKNOWN: 1,
  YELLOW: 2,
  GREEN: 3,
};

const ORDEM_TIER: Record<string, number> = {
  TIER_50: 0,
  TIER_250: 1,
  TIER_1K: 2,
  TIER_10K: 3,
  TIER_100K: 4,
  TIER_UNLIMITED: 5,
};

const STATUS_RUIM = new Set(["FLAGGED", "RESTRICTED", "DISCONNECTED", "BANNED"]);

function ordemQualidade(rating: string | null | undefined): number {
  if (!rating) return ORDEM_QUALIDADE.UNKNOWN;
  return ORDEM_QUALIDADE[rating] ?? ORDEM_QUALIDADE.UNKNOWN;
}

export function avaliarPioraQualidade(
  anterior: EstadoQualidadeNumero | null,
  atual: EstadoQualidadeNumero
): PioraDetectada {
  if (!anterior) return { piorou: false, motivo: null };

  const motivos: string[] = [];

  const ordemAnterior = ordemQualidade(anterior.qualityRating);
  const ordemAtual = ordemQualidade(atual.qualityRating);
  if (ordemAtual < ordemAnterior) {
    motivos.push(`qualidade caiu de ${anterior.qualityRating ?? "UNKNOWN"} para ${atual.qualityRating ?? "UNKNOWN"}`);
  }

  const tierAnterior = anterior.messagingLimitTier ? ORDEM_TIER[anterior.messagingLimitTier] : undefined;
  const tierAtual = atual.messagingLimitTier ? ORDEM_TIER[atual.messagingLimitTier] : undefined;
  if (tierAnterior !== undefined && tierAtual !== undefined && tierAtual < tierAnterior) {
    motivos.push(`limite de disparo caiu de ${anterior.messagingLimitTier} para ${atual.messagingLimitTier}`);
  }

  const statusEraRuim = anterior.status ? STATUS_RUIM.has(anterior.status) : false;
  const statusEhRuim = atual.status ? STATUS_RUIM.has(atual.status) : false;
  if (statusEhRuim && !statusEraRuim) {
    motivos.push(`status mudou para ${atual.status}`);
  }

  return { piorou: motivos.length > 0, motivo: motivos.length > 0 ? motivos.join("; ") : null };
}
