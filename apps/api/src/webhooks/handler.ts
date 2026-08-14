import type { OffersPort, CreateOfferInput, WebhookRecord } from "@plataforma-ofertas/domain";
import { verifyWebhookSignature, type SignatureInvalidReason, type WebhookSignatureScheme } from "./hmac";
import { resolveIdempotencyKey } from "./idempotency";

// Lógica de negócio do webhook de ingestão (itens 2, 3 e 46 do escopo original):
// - Não depende do Fastify nem do Prisma diretamente (só da interface OffersPort),
//   então é testável com um fake em memória, sem subir HTTP ou banco.
// - Não chama Limit, WhatsApp, roteamento ou Hyperflow — só valida, verifica
//   idempotência e grava. Tudo mais é assíncrono (workers).
//
// Cada parceiro pode mandar UM lead por requisição OU um array de vários leads
// (lote) numa única requisição — a assinatura é verificada uma única vez sobre o
// corpo bruto inteiro (como veio, antes de qualquer parse), e cada item do lote é
// processado (validado + gravado de forma idempotente) individualmente. Um item
// ruim dentro de um lote não invalida os outros — só ele volta como "invalid_payload"
// no resultado; a requisição como um todo ainda é 2xx (ver routes.ts), então o
// parceiro não reenvia o lote inteiro por causa de um item só.

export interface RawWebhookPayload {
  nome?: string;
  cpf: string;
  telefone?: string;
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

export interface HandleWebhookRequestParams {
  identificador: string;
  rawBody: string;
  body: RawWebhookPayload | RawWebhookPayload[];
  /** Headers da requisição, já em minúsculo (é como o Fastify entrega). */
  headers: Record<string, string | undefined>;
  toleranceSeconds: number;
  nowSeconds?: number;
}

export type WebhookItemOutcome =
  | { kind: "created"; offerId: string }
  | { kind: "duplicate"; offerId: string }
  | { kind: "invalid_payload"; reason: string };

export type HandleWebhookRequestOutcome =
  | { kind: "webhook_not_found" }
  | { kind: "invalid_signature"; reason: SignatureInvalidReason }
  | { kind: "single"; resultado: WebhookItemOutcome }
  | { kind: "batch"; resultados: WebhookItemOutcome[] };

export async function handleWebhookRequest(
  port: OffersPort,
  params: HandleWebhookRequestParams
): Promise<HandleWebhookRequestOutcome> {
  const webhook = await port.findActiveWebhookByIdentificador(params.identificador);
  if (!webhook) {
    return { kind: "webhook_not_found" };
  }

  const signatureCheck = verifyWebhookSignature({
    scheme: (webhook.esquemaAssinatura || "ofertas_v1") as WebhookSignatureScheme,
    secret: webhook.secretHmac,
    rawBody: params.rawBody,
    headers: params.headers,
    headerAssinatura: webhook.headerAssinatura,
    headerTimestamp: webhook.headerTimestamp,
    toleranceSeconds: params.toleranceSeconds,
    nowSeconds: params.nowSeconds,
  });
  if (!signatureCheck.valid) {
    return { kind: "invalid_signature", reason: signatureCheck.reason };
  }

  if (Array.isArray(params.body)) {
    const resultados: WebhookItemOutcome[] = [];
    for (const item of params.body) {
      resultados.push(await processOfferItem(port, webhook, item));
    }
    return { kind: "batch", resultados };
  }

  return { kind: "single", resultado: await processOfferItem(port, webhook, params.body) };
}

async function processOfferItem(
  port: OffersPort,
  webhook: WebhookRecord,
  body: RawWebhookPayload
): Promise<WebhookItemOutcome> {
  if (!body || !body.cpf || String(body.cpf).trim().length === 0) {
    return { kind: "invalid_payload", reason: "cpf é obrigatório" };
  }

  const { key: idempotencyKey } = resolveIdempotencyKey({
    explicitKey: body.idempotency_key,
    externalId: body.external_id,
    payload: body,
  });

  const input: CreateOfferInput = {
    webhookId: webhook.id,
    idempotencyKey,
    externalId: body.external_id ?? null,
    nome: body.nome ?? null,
    cpf: body.cpf,
    telefoneOriginal: body.telefone ?? null,
    bancoAutorizado: body.banco_autorizado ?? null,
    produto: body.produto ?? null,
    valor: body.valor ?? null,
    parcelas: body.parcelas ?? null,
    payloadOriginal: body,
    dadosAdicionais: body.dados_adicionais ?? null,
  };

  const result = await port.createOfferIdempotent(input);
  return result.created
    ? { kind: "created", offerId: result.offer.id }
    : { kind: "duplicate", offerId: result.offer.id };
}
