import { describe, expect, it } from "vitest";
import { computeSignature, computeSimpleHmac, verifyWebhookSignature } from "./hmac";

describe("verifyWebhookSignature — esquema ofertas_v1 (timestamp + signature)", () => {
  const secret = "test-secret";
  const rawBody = JSON.stringify({ telefone: "62999999999" });
  const nowSeconds = 1_700_000_000;

  it("aceita uma assinatura válida dentro da tolerância", () => {
    const timestamp = String(nowSeconds);
    const signature = computeSignature(secret, timestamp, rawBody);

    const result = verifyWebhookSignature({
      scheme: "ofertas_v1",
      secret,
      rawBody,
      headers: { "x-ofertas-timestamp": timestamp, "x-ofertas-signature": signature },
      headerAssinatura: "x-ofertas-signature",
      headerTimestamp: "x-ofertas-timestamp",
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result.valid).toBe(true);
  });

  it("rejeita quando faltam headers de timestamp/assinatura", () => {
    const result = verifyWebhookSignature({
      scheme: "ofertas_v1",
      secret,
      rawBody,
      headers: {},
      headerAssinatura: "x-ofertas-signature",
      headerTimestamp: "x-ofertas-timestamp",
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result).toEqual({ valid: false, reason: "missing_timestamp_or_signature" });
  });

  it("rejeita timestamp fora da janela de tolerância (proteção contra replay)", () => {
    const oldTimestamp = String(nowSeconds - 1000);
    const signature = computeSignature(secret, oldTimestamp, rawBody);

    const result = verifyWebhookSignature({
      scheme: "ofertas_v1",
      secret,
      rawBody,
      headers: { "x-ofertas-timestamp": oldTimestamp, "x-ofertas-signature": signature },
      headerAssinatura: "x-ofertas-signature",
      headerTimestamp: "x-ofertas-timestamp",
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
      scheme: "ofertas_v1",
      secret,
      rawBody: tamperedBody,
      headers: { "x-ofertas-timestamp": timestamp, "x-ofertas-signature": signature },
      headerAssinatura: "x-ofertas-signature",
      headerTimestamp: "x-ofertas-timestamp",
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejeita assinatura calculada com o segredo errado", () => {
    const timestamp = String(nowSeconds);
    const signature = computeSignature("outro-segredo", timestamp, rawBody);

    const result = verifyWebhookSignature({
      scheme: "ofertas_v1",
      secret,
      rawBody,
      headers: { "x-ofertas-timestamp": timestamp, "x-ofertas-signature": signature },
      headerAssinatura: "x-ofertas-signature",
      headerTimestamp: "x-ofertas-timestamp",
      toleranceSeconds: 300,
      nowSeconds,
    });

    expect(result.valid).toBe(false);
  });
});

describe("verifyWebhookSignature — esquema hmac_sha256_simple (um único header, sem timestamp)", () => {
  const secret = "test-secret";
  const rawBody = JSON.stringify({ telefone: "85992100340" });

  it("aceita uma assinatura válida", () => {
    const signature = computeSimpleHmac(secret, rawBody);

    const result = verifyWebhookSignature({
      scheme: "hmac_sha256_simple",
      secret,
      rawBody,
      headers: { "x-odysseia-signature": signature },
      headerAssinatura: "x-odysseia-signature",
      toleranceSeconds: 300,
    });

    expect(result.valid).toBe(true);
  });

  it("rejeita quando o header de assinatura está ausente", () => {
    const result = verifyWebhookSignature({
      scheme: "hmac_sha256_simple",
      secret,
      rawBody,
      headers: {},
      headerAssinatura: "x-odysseia-signature",
      toleranceSeconds: 300,
    });

    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("rejeita quando o corpo foi alterado após a assinatura", () => {
    const signature = computeSimpleHmac(secret, rawBody);
    const tamperedBody = JSON.stringify({ telefone: "62988888888" });

    const result = verifyWebhookSignature({
      scheme: "hmac_sha256_simple",
      secret,
      rawBody: tamperedBody,
      headers: { "x-odysseia-signature": signature },
      headerAssinatura: "x-odysseia-signature",
      toleranceSeconds: 300,
    });

    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejeita assinatura calculada com o segredo errado", () => {
    const signature = computeSimpleHmac("outro-segredo", rawBody);

    const result = verifyWebhookSignature({
      scheme: "hmac_sha256_simple",
      secret,
      rawBody,
      headers: { "x-odysseia-signature": signature },
      headerAssinatura: "x-odysseia-signature",
      toleranceSeconds: 300,
    });

    expect(result.valid).toBe(false);
  });

  it("não exige nem valida timestamp (esquema não tem replay protection)", () => {
    const signature = computeSimpleHmac(secret, rawBody);

    const result = verifyWebhookSignature({
      scheme: "hmac_sha256_simple",
      secret,
      rawBody,
      headers: { "x-odysseia-signature": signature, "x-timestamp-qualquer": "0" },
      headerAssinatura: "x-odysseia-signature",
      toleranceSeconds: 300,
    });

    expect(result.valid).toBe(true);
  });
});

describe("verifyWebhookSignature — esquema token_simples (segredo em texto puro, sem hash)", () => {
  const secret = "segredo-fixo-do-parceiro-abc123";
  const rawBody = JSON.stringify({ cpf: "12345678900" });

  it("aceita quando o header traz o segredo exato", () => {
    const result = verifyWebhookSignature({
      scheme: "token_simples",
      secret,
      rawBody,
      headers: { "x-parceiro-token": secret },
      headerAssinatura: "x-parceiro-token",
      toleranceSeconds: 300,
    });

    expect(result).toEqual({ valid: true });
  });

  it("rejeita quando o header traz um valor diferente do segredo", () => {
    const result = verifyWebhookSignature({
      scheme: "token_simples",
      secret,
      rawBody,
      headers: { "x-parceiro-token": "valor-errado" },
      headerAssinatura: "x-parceiro-token",
      toleranceSeconds: 300,
    });

    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejeita quando o header nem veio na requisição", () => {
    const result = verifyWebhookSignature({
      scheme: "token_simples",
      secret,
      rawBody,
      headers: {},
      headerAssinatura: "x-parceiro-token",
      toleranceSeconds: 300,
    });

    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("não importa o corpo da requisição — não é usado no cálculo desse esquema", () => {
    const result = verifyWebhookSignature({
      scheme: "token_simples",
      secret,
      rawBody: "corpo completamente diferente, não faz diferença nesse esquema",
      headers: { "x-parceiro-token": secret },
      headerAssinatura: "x-parceiro-token",
      toleranceSeconds: 300,
    });

    expect(result.valid).toBe(true);
  });

  it("rejeita um segredo que é só um prefixo do valor certo (tamanhos diferentes)", () => {
    const result = verifyWebhookSignature({
      scheme: "token_simples",
      secret,
      rawBody,
      headers: { "x-parceiro-token": secret.slice(0, 10) },
      headerAssinatura: "x-parceiro-token",
      toleranceSeconds: 300,
    });

    expect(result.valid).toBe(false);
  });
});
