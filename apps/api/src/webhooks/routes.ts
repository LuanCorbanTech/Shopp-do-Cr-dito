import type { FastifyInstance, FastifyReply } from "fastify";
import type { OffersPort } from "@plataforma-ofertas/domain";
import { logger, maskCpf } from "@plataforma-ofertas/shared";
import { handleWebhookRequest, type RawWebhookPayload, type WebhookItemOutcome } from "./handler";
import { webhookBodySchema, webhookParamsSchema } from "./schema";

export function registerWebhookRoutes(
  app: FastifyInstance,
  port: OffersPort,
  toleranceSeconds: number
): void {
  // Log próprio (não o do Fastify, que fica com logger:false em server.ts) —
  // só pros casos de ERRO (404/401/400), pra dar pra investigar sem precisar
  // ficar pedindo pro parceiro mandar o corpo da resposta dele. Resume o
  // payload em vez de logar bruto: nunca solta CPF/telefone completos (usa
  // maskCpf), só o suficiente pra saber "veio como número? faltou o campo?".
  function logFalhaWebhook(identificador: string, motivo: string, body: unknown) {
    const resumoBody = (() => {
      if (Array.isArray(body)) {
        return { tipo: "array", tamanho: body.length, primeiroItem: resumoItem(body[0]) };
      }
      return resumoItem(body);
    })();
    logger.warn({ identificador, motivo, body: resumoBody }, "Webhook de ofertas rejeitado");
  }
  function resumoItem(item: unknown) {
    if (!item || typeof item !== "object") return { tipoRecebido: typeof item };
    const obj = item as Record<string, unknown>;
    return {
      camposPresentes: Object.keys(obj),
      cpfTipo: typeof obj.cpf,
      cpfMascarado: typeof obj.cpf === "string" ? maskCpf(obj.cpf) : undefined,
    };
  }

  app.post<{ Params: { identificador: string }; Body: RawWebhookPayload | RawWebhookPayload[] }>(
    "/webhooks/ofertas/:identificador",
    // attachValidation (em vez de deixar o Fastify rejeitar sozinho): assim dá
    // pra LOGAR erro de schema também (ex.: cpf mandado como número em vez de
    // texto) — sem isso, essa rejeição acontecia antes até de chegar aqui, e
    // ficava impossível de investigar depois (foi exatamente o que aconteceu
    // com o teste da Odysseia).
    { schema: { params: webhookParamsSchema, body: webhookBodySchema }, attachValidation: true },
    async (request, reply) => {
      if (request.validationError) {
        logFalhaWebhook(request.params.identificador, `schema_invalido:${request.validationError.message}`, request.body);
        return reply.code(400).send({ error: "payload_invalido", motivo: request.validationError.message });
      }

      const outcome = await handleWebhookRequest(port, {
        identificador: request.params.identificador,
        rawBody: request.rawBody ?? JSON.stringify(request.body),
        body: request.body,
        headers: normalizeHeaders(request.headers),
        toleranceSeconds,
      });

      switch (outcome.kind) {
        case "webhook_not_found":
          logFalhaWebhook(request.params.identificador, "webhook_nao_encontrado", request.body);
          return reply.code(404).send({ error: "webhook_nao_encontrado" });
        case "invalid_signature":
          logFalhaWebhook(request.params.identificador, `assinatura_invalida:${outcome.reason}`, request.body);
          return reply.code(401).send({ error: "assinatura_invalida", motivo: outcome.reason });
        case "test_ping":
          // Payload de verificação (ex.: Odysseia, antes de trocar a URL de
          // destino) — só confirma que chegou e a assinatura bateu, não grava
          // nada.
          return reply.code(200).send({ status: "teste_ok" });
        case "single":
          if (outcome.resultado.kind === "invalid_payload") {
            logFalhaWebhook(request.params.identificador, `payload_invalido:${outcome.resultado.reason}`, request.body);
          }
          return sendItemResult(reply, outcome.resultado);
        case "batch": {
          // A requisição em si foi aceita e processada (2xx) mesmo que itens
          // individuais do lote tenham falhado na validação — só um problema de
          // assinatura/webhook faz o lote inteiro voltar pra fila do parceiro.
          const criados = outcome.resultados.filter((r) => r.kind === "created").length;
          const resetados = outcome.resultados.filter((r) => r.kind === "reset").length;
          const duplicados = outcome.resultados.filter((r) => r.kind === "duplicate").length;
          const invalidos = outcome.resultados.filter((r) => r.kind === "invalid_payload").length;
          return reply.code(200).send({
            status: "processado",
            total: outcome.resultados.length,
            criados,
            resetados,
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
    case "reset":
      // Mesmo fornecedor mandou o mesmo CPF de novo — reaproveita a oferta
      // existente, reiniciando o fluxo do zero (pedido explícito: nunca
      // duplica pro mesmo fornecedor).
      return reply.code(200).send({ status: "reprocessado", offerId: resultado.offerId });
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
