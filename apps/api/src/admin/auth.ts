import type { FastifyRequest, FastifyReply } from "fastify";

// Autenticação administrativa (item 41 do escopo original) — MVP com token Bearer
// estático via variável de ambiente. Simplificação deliberada: o escopo pede
// "autenticação administrativa; controle de permissões" (RBAC), mas sem um cadastro
// de usuários definido, um token único cobre o requisito mínimo de "só quem tem a
// credencial acessa o painel" sem inventar um esquema de usuários não especificado.
// Evolução natural: trocar por JWT com usuários/papéis quando o painel tiver login
// multiusuário — a rota fica isolada aqui, então a troca não afeta o resto da API.
export async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.ADMIN_API_TOKEN;
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!expected || !token || token !== expected) {
    reply.code(401).send({ error: "nao_autorizado" });
  }
}
