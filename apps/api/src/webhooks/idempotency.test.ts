import { describe, expect, it } from "vitest";
import { resolveIdempotencyKey, stableStringify } from "./idempotency";

describe("resolveIdempotencyKey", () => {
  it("prioriza a chave explícita quando presente", () => {
    const result = resolveIdempotencyKey({
      explicitKey: "chave-explicita",
      externalId: "ext-123",
      payload: { a: 1 },
    });

    expect(result).toEqual({ key: "chave-explicita", source: "explicit" });
  });

  it("usa external_id quando não há chave explícita", () => {
    const result = resolveIdempotencyKey({
      explicitKey: undefined,
      externalId: "ext-123",
      payload: { a: 1 },
    });

    expect(result).toEqual({ key: "ext-123", source: "external_id" });
  });

  it("cai para hash do payload quando nenhum identificador é enviado", () => {
    const result = resolveIdempotencyKey({
      explicitKey: undefined,
      externalId: undefined,
      payload: { a: 1, b: 2 },
    });

    expect(result.source).toBe("payload_hash");
    expect(result.key).toHaveLength(64); // sha256 em hex
  });

  it("o hash do payload é igual independentemente da ordem das chaves", () => {
    const a = resolveIdempotencyKey({ payload: { a: 1, b: 2 } });
    const b = resolveIdempotencyKey({ payload: { b: 2, a: 1 } });

    expect(a.key).toBe(b.key);
  });

  it("stableStringify ordena as chaves recursivamente", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
