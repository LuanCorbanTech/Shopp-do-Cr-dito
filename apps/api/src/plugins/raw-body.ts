import type { FastifyInstance } from "fastify";

// Preserva o corpo bruto da requisição (necessário para verificar a assinatura HMAC,
// que é calculada sobre os bytes exatos enviados pela origem — não sobre o objeto
// já reserializado pelo parser JSON padrão).
export function registerRawBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      const raw = typeof body === "string" ? body : String(body);
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );
}
