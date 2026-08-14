import type { FastifyInstance, FastifyReply } from "fastify";
import type { OffersPort } from "@plataforma-ofertas/domain";
import { handleWebhookRequest, type RawWebhookPayload, type WebhookItemOutcome } from "./handler";
import { webhookBodySchema, webhookParamsSchema } from "./schema";

export function registerWebhookRoutes(
  app: FastifyInstance,
  port: OffersPort,
  toleranceSeconds: number
): void {
  app.post<{ Params: { identificador: string }; Body: RawWebhookPayload | RawWebhookPayload[] }>(
    "/webhooks/ofertas/:identificador",
    { schema: { params: webhookParamsSchema, body: webhookBodySchema } },
    async (request, reply) => {
      const outcome = await handleWebhookRequest(port, {
        identificador: request.params.identificador,
        rawBody: request.rawBody ?? JSON.stringify(request.body),
        body: request.body,
        headers: normalizeHeaders(request.headers),
        toleranceSeconds,
      });

      switch (outcome.kind) {
        case "webhook_not_found":
          return reply.code(404).send({ error: "webhook_nao_encontrado" });
        case "invalid_signature":
          return reply.code(401).send({ error: "assinatura_invalida", motivo: outcome.reason });
        case "single":
          return sendItemResult(reply, outcome.resultado);
        case "batch": {
          // A requisição em si foi aceita e processada (2xx) mesmo que itens
          // individuais do lote tenham falhado na validação — só um problema de
          // assinatura/webhook faz o lote inteiro voltar pra fila do parceiro.
          const criados = outcome.resultados.filter((r) => r.kind === "created").length;
          const duplicados = outcome.resultados.filter((r) => r.kind === "duplicate").length;
          const invalidos = outcome.resultados.filter((r) => r.kind === "invalid_payload").length;
          return reply.code(200).send({
            status: "processado",
            total: outcome.resultados.length,
            criados,
            duplicados,
            invalidos,
            resultados: outcome.resultados,
          });
        }
        default:
          return reply.code(500).send({ error: "erro_interno" });
      }
    }
  );
}

function sendItemResult(reply: FastifyReply, resultado: WebhookItemOutcome) {
  switch (resultado.kind) {
    case "created":
      return reply.code(201).send({ status: "recebido", offerId: resultado.offerId });
    case "duplicate":
      return reply.code(200).send({ status: "ja_recebido", offerId: resultado.offerId });
    case "invalid_payload":
      return reply.code(400).send({ error: "payload_invalido", motivo: resultado.reason });
  }
}

/** Fastify entrega os headers já em minúsculo; isso só normaliza o caso de header repetido (array). */
function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}
