import type { FastifyInstance } from "fastify";
import type { DispatchPollPort } from "@plataforma-ofertas/domain";

// Endpoint de atualização de status pós-disparo (19/08) — o sistema de
// disparo de WhatsApp chama isso DUAS vezes por lead, em momentos
// diferentes:
//   1. Quando ele efetivamente MANDA a mensagem (depois de já ter consultado
//      o lead via GET /api/v1/leads/aguardando-disparo) -> status "enviado".
//   2. Quando o CLIENTE responde a mensagem -> status "respondido" (pode
//      nunca acontecer, se o cliente não responder).
//
// Aceita identificar o lead por "id" (o nosso, devolvido no GET) OU
// "externalId" (o do parceiro) — o que estiver disponível do lado deles.
//
// Autenticação: mesmo token do endpoint de consulta (DISPATCH_API_TOKEN).
export function registerAtualizarStatusDisparoRoutes(
  app: FastifyInstance,
  port: DispatchPollPort,
  expectedToken: string | undefined
): void {
  app.post<{ Body: { id?: string; externalId?: string; status?: string } }>(
    "/api/v1/leads/status",
    async (request, reply) => {
      if (!expectedToken) {
        reply.code(503);
        return {
          error: "servico_indisponivel",
          mensagem: "Esse endpoint ainda não foi configurado (falta DISPATCH_API_TOKEN no servidor).",
        };
      }

      const authHeader = request.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
      if (!token || token !== expectedToken) {
        reply.code(401);
        return { error: "token_invalido" };
      }

      const { id, externalId, status } = request.body ?? {};

      if (!id && !externalId) {
        reply.code(400);
        return { error: "identificador_obrigatorio", mensagem: "Informe \"id\" ou \"externalId\" pra identificar o lead." };
      }

      const statusMap: Record<string, "DISPARO_ENVIADO" | "DISPARO_RESPONDIDO"> = {
        enviado: "DISPARO_ENVIADO",
        respondido: "DISPARO_RESPONDIDO",
      };
      const novoStatus = status ? statusMap[status] : undefined;
      if (!novoStatus) {
        reply.code(400);
        return { error: "status_invalido", mensagem: 'O campo "status" precisa ser "enviado" ou "respondido".' };
      }

      const oferta = await port.atualizarStatusDisparo({ id, externalId, novoStatus });
      if (!oferta) {
        reply.code(404);
        return { error: "lead_nao_encontrado" };
      }

      return { status: "atualizado", id: oferta.id, novoStatus: oferta.status };
    }
  );
}
