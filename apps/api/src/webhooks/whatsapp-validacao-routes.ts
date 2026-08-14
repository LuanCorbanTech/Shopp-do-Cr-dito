import type { FastifyInstance } from "fastify";
import type { WhatsappValidationPort, IntegrationConfigPort } from "@plataforma-ofertas/domain";
import { handleWhatsappValidacaoWebhook, type WhatsappValidacaoWebhookBody } from "./whatsapp-validacao-handler";

export function registerWhatsappValidacaoWebhookRoutes(
  app: FastifyInstance,
  port: WhatsappValidationPort,
  configPort: IntegrationConfigPort,
  expectedToken: string
): void {
  app.post<{ Querystring: { token?: string }; Body: WhatsappValidacaoWebhookBody }>(
    "/webhooks/whatsapp-validacao",
    async (request, reply) => {
      const outcome = await handleWhatsappValidacaoWebhook(port, configPort, {
        token: request.query.token,
        expectedToken,
        body: request.body,
      });

      switch (outcome.kind) {
        case "processed":
          return reply.code(200).send({ status: "processado" });
        case "invalid_token":
          return reply.code(401).send({ error: "token_invalido" });
        case "request_id_ausente":
          return reply.code(400).send({ error: "request_id_ausente" });
        // 200 mesmo sem achar a oferta: não é um erro para a CorbanTech retentar
        // (ver comentário no handler — pode já ter sido resolvida pelo fallback).
        case "oferta_nao_encontrada":
          return reply.code(200).send({ status: "ignorado", motivo: "oferta_nao_encontrada" });
        default:
          return reply.code(500).send({ error: "erro_interno" });
      }
    }
  );
}
