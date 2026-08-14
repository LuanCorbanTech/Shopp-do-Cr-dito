import type { FastifyInstance } from "fastify";
import type { OffersPort } from "@plataforma-ofertas/domain";
import { handleWebhookOffer, type RawWebhookPayload } from "./handler";
import { webhookBodySchema, webhookParamsSchema } from "./schema";

export function registerWebhookRoutes(
  app: FastifyInstance,
  port: OffersPort,
  toleranceSeconds: number
): void {
  app.post<{ Params: { identificador: string }; Body: RawWebhookPayload }>(
    "/webhooks/ofertas/:identificador",
    { schema: { params: webhookParamsSchema, body: webhookBodySchema } },
    async (request, reply) => {
      const outcome = await handleWebhookOffer(port, {
        identificador: request.params.identificador,
        rawBody: request.rawBody ?? JSON.stringify(request.body),
        body: request.body,
        headers: {
          timestamp: request.headers["x-ofertas-timestamp"] as string | undefined,
          signature: request.headers["x-ofertas-signature"] as string | undefined,
        },
        toleranceSeconds,
      });

      switch (outcome.kind) {
        case "created":
          return reply.code(201).send({ status: "recebido", offerId: outcome.offerId });
        case "duplicate":
          return reply.code(200).send({ status: "ja_recebido", offerId: outcome.offerId });
        case "webhook_not_found":
          return reply.code(404).send({ error: "webhook_nao_encontrado" });
        case "invalid_signature":
          return reply.code(401).send({ error: "assinatura_invalida", motivo: outcome.reason });
        case "invalid_payload":
          return reply.code(400).send({ error: "payload_invalido", motivo: outcome.reason });
        default:
          return reply.code(500).send({ error: "erro_interno" });
      }
    }
  );
}
