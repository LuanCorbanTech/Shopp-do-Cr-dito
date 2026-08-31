import type { FastifyInstance } from "fastify";
import type { DispatchPollPort } from "@plataforma-ofertas/domain";

// Endpoint de consulta por telefone (31/08) — o sistema externo de disparo
// de WhatsApp usa isso pra "quem é esse número" quando recebe uma
// mensagem/resposta de um telefone que não reconhece de imediato: consulta
// aqui e recebe de volta os dados que já temos daquele lead (CPF, nome,
// etc.), se algum já existir.
//
// Autenticação: MESMO token dos outros 2 endpoints de disparo
// (DISPATCH_API_TOKEN, header "Authorization: Bearer <token>") — não é uma
// chave por time; é o mesmo sistema externo único que já usa os outros 2.
//
// Telefone: aceita com ou sem "+", com ou sem DDI — normaliza do mesmo jeito
// que o resto do sistema já faz antes de comparar no banco.
export function registerBuscarPorTelefoneRoutes(
  app: FastifyInstance,
  port: DispatchPollPort,
  expectedToken: string | undefined
): void {
  app.get<{ Querystring: { telefone?: string } }>(
    "/api/v1/leads/buscar-por-telefone",
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

      const telefoneBruto = request.query.telefone;
      if (!telefoneBruto || !telefoneBruto.trim()) {
        reply.code(400);
        return { error: "telefone_obrigatorio", mensagem: 'Informe o telefone em "?telefone=...".' };
      }

      // Mesma normalização usada no resto do sistema (ver
      // montarNumeroCompleto/telefoneParecValido nos workers): só dígitos, e
      // se tiver 10 ou 11 dígitos (sem DDI), assume Brasil (55) — igual a
      // como os números já são gravados no banco.
      let digitos = telefoneBruto.replace(/\D/g, "");
      if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;

      const oferta = await port.buscarOfertaMaisRecentePorTelefone(digitos);
      if (!oferta) {
        reply.code(404);
        return { error: "nao_encontrado", mensagem: "Nenhuma oferta encontrada com esse telefone." };
      }

      // Mesmo formato de campos do GET /aguardando-disparo — contrato já
      // conhecido desse mesmo sistema externo.
      return {
        id: oferta.id,
        externalId: oferta.externalId,
        nome: oferta.nome,
        cpf: oferta.cpf,
        dataNascimento: oferta.dataNascimento ? oferta.dataNascimento.toISOString() : null,
        telefoneWhatsapp: oferta.telefoneValidado,
        possuiWhatsapp: oferta.possuiWhatsapp,
        bancoAutorizado: oferta.bancoAutorizado,
        produto: oferta.produto,
        valor: oferta.valor,
        parcelas: oferta.parcelas,
        status: oferta.status,
      };
    }
  );
}
