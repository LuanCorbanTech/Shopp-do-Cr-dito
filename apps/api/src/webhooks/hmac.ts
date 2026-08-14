import { createHmac, timingSafeEqual } from "node:crypto";

// Assinatura de webhook (item 41 do escopo original: HMAC, proteção contra replay).
// Esquema: HMAC-SHA256(secret, `${timestamp}.${rawBody}`), com timestamp validado
// dentro de uma janela de tolerância — impede reenvio de uma requisição capturada
// (replay) mesmo que o payload seja idêntico.

export interface VerifySignatureParams {
  secret: string;
  rawBody: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  toleranceSeconds: number;
  /** Injeção de tempo para testes; usa Date.now() em produção. */
  nowSeconds?: number;
}

export type SignatureInvalidReason =
  | "missing_timestamp_or_signature"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch";

export type VerifySignatureResult = { valid: true } | { valid: false; reason: SignatureInvalidReason };

export function computeSignature(secret: string, timestamp: string | number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyWebhookSignature(params: VerifySignatureParams): VerifySignatureResult {
  const { secret, rawBody, timestampHeader, signatureHeader, toleranceSeconds } = params;

  if (!timestampHeader || !signatureHeader) {
    return { valid: false, reason: "missing_timestamp_or_signature" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: "invalid_timestamp" };
  }

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = computeSignature(secret, timestampHeader, rawBody);
  if (!safeCompareHex(expected, signatureHeader)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}

function safeCompareHex(expectedHex: string, providedHex: string): boolean {
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex, "hex");
    providedBuf = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}
