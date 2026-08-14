import type { OffersPort, CreateOfferInput } from "@plataforma-ofertas/domain";
import { verifyWebhookSignature, type SignatureInvalidReason } from "./hmac";
import { resolveIdempotencyKey } from "./idempotency";

// Lógica de negócio do webhook de ingestão (itens 2, 3 e 46 do escopo original):
// - Não depende do Fastify nem do Prisma diretamente (só da interface OffersPort),
//   então é testável com um fake em memória, sem subir HTTP ou banco.
// - Não chama Limit, WhatsApp, roteamento ou Hyperflow — só valida, verifica
//   idempotência e grava. Tudo mais é assíncrono (workers).

export interface RawWebhookPayload {
  nome?: string;
  cpf?: string;
  telefone: string;
  banco_autorizado?: string;
  external_id?: string;
  idempotency_key?: string;
  produto?: string;
  valor?: number;
  parcelas?: number;
  origem?: string;
  data_hora?: string;
  dados_adicionais?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HandleWebhookOfferParams {
  identificador: string;
  rawBody: string;
  body: RawWebhookPayload;
  headers: {
    timestamp?: string;
    signature?: string;
  };
  toleranceSeconds: number;
  nowSeconds?: number;
}

export type HandleWebhookOfferOutcome =
  | { kind: "created"; offerId: string }
  | { kind: "duplicate"; offerId: string }
  | { kind: "webhook_not_found" }
  | { kind: "invalid_signature"; reason: SignatureInvalidReason }
  | { kind: "invalid_payload"; reason: string };

export async function handleWebhookOffer(
  port: OffersPort,
  params: HandleWebhookOfferParams
): Promise<HandleWebhookOfferOutcome> {
  const webhook = await port.findActiveWebhookByIdentificador(params.identificador);
  if (!webhook) {
    return { kind: "webhook_not_found" };
  }

  const signatureCheck = verifyWebhookSignature({
    secret: webhook.secretHmac,
    rawBody: params.rawBody,
    timestampHeader: params.headers.timestamp,
    signatureHeader: params.headers.signature,
    toleranceSeconds: params.toleranceSeconds,
    nowSeconds: params.nowSeconds,
  });
  if (!signatureCheck.valid) {
    return { kind: "invalid_signature", reason: signatureCheck.reason };
  }

  if (!params.body.telefone || params.body.telefone.trim().length === 0) {
    return { kind: "invalid_payload", reason: "telefone é obrigatório" };
  }

  const { key: idempotencyKey } = resolveIdempotencyKey({
    explicitKey: params.body.idempotency_key,
    externalId: params.body.external_id,
    payload: params.body,
  });

  const input: CreateOfferInput = {
    webhookId: webhook.id,
    idempotencyKey,
    externalId: params.body.external_id ?? null,
    nome: params.body.nome ?? null,
    cpf: params.body.cpf ?? null,
    telefoneOriginal: params.body.telefone,
    bancoAutorizado: params.body.banco_autorizado ?? null,
    produto: params.body.produto ?? null,
    valor: params.body.valor ?? null,
    parcelas: params.body.parcelas ?? null,
    payloadOriginal: params.body,
    dadosAdicionais: params.body.dados_adicionais ?? null,
  };

  const result = await port.createOfferIdempotent(input);
  return result.created
    ? { kind: "created", offerId: result.offer.id }
    : { kind: "duplicate", offerId: result.offer.id };
}
