import { createHmac, timingSafeEqual } from "node:crypto";

// Assinatura de webhook (item 41 do escopo original: HMAC, proteção contra replay).
// Nem todo fornecedor de leads assina do mesmo jeito — por isso o esquema é uma
// propriedade do parceiro (Webhook.esquemaAssinatura), não algo fixo no código:
//
//   "ofertas_v1"          -> esquema original, dois headers (timestamp + signature):
//                            HMAC-SHA256(secret, `${timestamp}.${rawBody}`), com o
//                            timestamp validado numa janela de tolerância — impede
//                            reenvio de uma requisição capturada (replay) mesmo que
//                            o payload seja idêntico.
//   "hmac_sha256_simple"  -> um único header: HMAC-SHA256(secret, rawBody) em hex,
//                            sem timestamp/replay. Usado por fornecedores que só
//                            expõem um header de assinatura (ex.: Odysseia, com
//                            X-Odysseia-Signature) — ver docs/integrations se/quando
//                            eles formalizarem isso em documentação; por enquanto é
//                            a leitura mais comum desse tipo de header único.

export type WebhookSignatureScheme = "ofertas_v1" | "hmac_sha256_simple";

export interface VerifySignatureParams {
  scheme: WebhookSignatureScheme;
  secret: string;
  rawBody: string;
  /** Headers da requisição, já em minúsculo (é como o Fastify entrega). */
  headers: Record<string, string | undefined>;
  /** Nome (minúsculo) do header com a assinatura — configurado por parceiro. */
  headerAssinatura: string;
  /** Só usado no esquema "ofertas_v1" — nome (minúsculo) do header com o timestamp. */
  headerTimestamp?: string | null;
  toleranceSeconds: number;
  /** Injeção de tempo para testes; usa Date.now() em produção. */
  nowSeconds?: number;
}

export type SignatureInvalidReason =
  | "missing_timestamp_or_signature"
  | "missing_signature"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch";

export type VerifySignatureResult = { valid: true } | { valid: false; reason: SignatureInvalidReason };

/** Esquema original: HMAC-SHA256(secret, "timestamp.corpo") — ver "ofertas_v1" acima. */
export function computeSignature(secret: string, timestamp: string | number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Esquema de header único: HMAC-SHA256(secret, corpo) — ver "hmac_sha256_simple" acima. */
export function computeSimpleHmac(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(params: VerifySignatureParams): VerifySignatureResult {
  const signatureHeader = params.headers[params.headerAssinatura.toLowerCase()];

  if (params.scheme === "hmac_sha256_simple") {
    if (!signatureHeader) {
      return { valid: false, reason: "missing_signature" };
    }
    const expected = computeSimpleHmac(params.secret, params.rawBody);
    if (!safeCompareHex(expected, signatureHeader)) {
      return { valid: false, reason: "signature_mismatch" };
    }
    return { valid: true };
  }

  // "ofertas_v1"
  const timestampHeaderName = params.headerTimestamp?.toLowerCase();
  const timestampHeader = timestampHeaderName ? params.headers[timestampHeaderName] : undefined;

  if (!timestampHeader || !signatureHeader) {
    return { valid: false, reason: "missing_timestamp_or_signature" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: "invalid_timestamp" };
  }

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > params.toleranceSeconds) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = computeSignature(params.secret, timestampHeader, params.rawBody);
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
