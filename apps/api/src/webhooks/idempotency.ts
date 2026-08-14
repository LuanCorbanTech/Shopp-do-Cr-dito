import { createHash } from "node:crypto";

// Resolução da chave de idempotência (itens 2 e 3 do escopo original).
// Prioridade: chave explícita enviada pela origem > external_id > hash determinístico
// do payload inteiro (fallback para origens que não enviam nenhum identificador —
// dedupe garantido apenas para payloads byte-a-byte equivalentes).

export interface IdempotencyInput {
  explicitKey?: string | null;
  externalId?: string | null;
  payload: unknown;
}

export interface IdempotencyResolution {
  key: string;
  source: "explicit" | "external_id" | "payload_hash";
}

export function resolveIdempotencyKey({
  explicitKey,
  externalId,
  payload,
}: IdempotencyInput): IdempotencyResolution {
  if (explicitKey && explicitKey.trim().length > 0) {
    return { key: explicitKey.trim(), source: "explicit" };
  }
  if (externalId && externalId.trim().length > 0) {
    return { key: externalId.trim(), source: "external_id" };
  }
  const hash = createHash("sha256").update(stableStringify(payload)).digest("hex");
  return { key: hash, source: "payload_hash" };
}

/** JSON.stringify determinístico (ordena chaves) — garante mesmo hash para o mesmo
 * conteúdo lógico, independentemente da ordem de serialização da origem. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortForStableStringify(record[key]);
        return acc;
      }, {});
  }
  return value;
}
