import { describe, expect, it } from "vitest";
import { computeSignature, verifyWebhookSignature } from "./hmac";

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";
  const rawBody = JSON.stringify({ telefone: "62999999999" });
  const nowSeconds = 1_700_000_000;

  it("aceita uma assinatura válida dentro da tolerância", () => {
    const timestamp = String(nowSeconds);
    const signature = computeSignature(secret, timestamp, rawBody);

    const result = verifyWebhookSignature({
      secret,
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: signature,
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result.valid).toBe(true);
  });

  it("rejeita quando faltam headers de timestamp/assinatura", () => {
    const result = verifyWebhookSignature({
      secret,
      rawBody,
      timestampHeader: undefined,
      signatureHeader: undefined,
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result).toEqual({ valid: false, reason: "missing_timestamp_or_signature" });
  });

  it("rejeita timestamp fora da janela de tolerância (proteção contra replay)", () => {
    const oldTimestamp = String(nowSeconds - 1000);
    const signature = computeSignature(secret, oldTimestamp, rawBody);

    const result = verifyWebhookSignature({
      secret,
      rawBody,
      timestampHeader: oldTimestamp,
      signatureHeader: signature,
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result).toEqual({ valid: false, reason: "timestamp_out_of_tolerance" });
  });

  it("rejeita quando o corpo foi alterado após a assinatura", () => {
    const timestamp = String(nowSeconds);
    const signature = computeSignature(secret, timestamp, rawBody);
    const tamperedBody = JSON.stringify({ telefone: "62988888888" });

    const result = verifyWebhookSignature({
      secret,
      rawBody: tamperedBody,
      timestampHeader: timestamp,
      signatureHeader: signature,
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejeita assinatura calculada com o segredo errado", () => {
    const timestamp = String(nowSeconds);
    const signature = computeSignature("outro-segredo", timestamp, rawBody);

    const result = verifyWebhookSignature({
      secret,
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: signature,
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result.valid).toBe(false);
  });
});
