import type { FastifyInstance } from "fastify";
import type { DispatchPollPort } from "@plataforma-ofertas/domain";

// Endpoint de disparo por polling externo (17/08) — substitui o motor de
// roteamento interno (Regras de Roteamento + Endpoints + Worker de Disparo,
// que continuam existindo no código mas nenhuma oferta real alcança mais
// desde essa mudança).
//
// Um sistema externo (o disparador de WhatsApp) chama esse endpoint pra
// buscar ofertas com status AGUARDANDO_DISPARO (validação de WhatsApp já
// concluída com sucesso); a própria leitura já marca a oferta como
// DISPARO_CONSULTADO — nunca mais aparece de novo nessa consulta, mesmo com
// chamadas concorrentes (ver claimOffersAguardandoDisparo, atômico via
// UPDATE...RETURNING com SKIP LOCKED).
//
// Autenticação: token fixo simples via header "Authorization: Bearer <token>"
// (não crasha o servidor se DISPATCH_API_TOKEN não estiver configurada —
// devolve 503 nesse caso, igual outras integrações externas do sistema).
export function registerAguardandoDisparoRoutes(
  app: FastifyInstance,
  port: DispatchPollPort,
  expectedToken: string | undefined
): void {
  app.get<{ Querystring: { limit?: string } }>(
    "/api/v1/leads/aguardando-disparo",
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

      const limitRaw = Number(request.query.limit);
      // Padrão 50, teto 200 — evita alguém pedir um lote gigante sem querer.
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50;

      const ofertas = await port.claimOffersAguardandoDisparo(limit);

      return {
        total: ofertas.length,
        leads: ofertas.map((o) => ({
          id: o.id,
          externalId: o.externalId,
          nome: o.nome,
          cpf: o.cpf,
          dataNascimento: o.dataNascimento ? o.dataNascimento.toISOString() : null,
          telefoneWhatsapp: o.telefoneValidado,
          possuiWhatsapp: o.possuiWhatsapp,
          bancoAutorizado: o.bancoAutorizado,
          produto: o.produto,
          valor: o.valor,
          parcelas: o.parcelas,
        })),
      };
    }
  );
}
