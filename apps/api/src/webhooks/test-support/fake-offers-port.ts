import type {
  OffersPort,
  WebhookRecord,
  CreateOfferInput,
  CreateOfferResult,
  OfferRecord,
} from "@plataforma-ofertas/domain";

// Implementação em memória de OffersPort, usada só em testes — permite testar
// handler.ts (idempotência, validação, roteamento de erros) sem subir Postgres.
export function createFakeOffersPort(webhooks: WebhookRecord[]): {
  port: OffersPort;
  offersByKey: Map<string, OfferRecord>;
  offersByCpf: Map<string, OfferRecord>;
} {
  const offersByKey = new Map<string, OfferRecord>();
  const offersByCpf = new Map<string, OfferRecord>();
  let counter = 0;

  const port: OffersPort = {
    async findActiveWebhookByIdentificador(identificador: string) {
      const webhook = webhooks.find((w) => w.identificador === identificador);
      if (!webhook || !webhook.ativo) return null;
      return webhook;
    },

    async createOfferIdempotent(input: CreateOfferInput): Promise<CreateOfferResult> {
      // Mesmo webhook + mesmo CPF já existe? Reseta (nunca duplica) — mesma
      // regra da implementação real (PrismaOffersPort). Normaliza o CPF (só
      // dígitos) antes de comparar, senão "123.456.789-00" e "12345678900"
      // (mesmo CPF, formatação diferente entre uma chamada e outra) seriam
      // tratados como CPFs diferentes — igual a implementação real faz com
      // regexp_replace.
      const cpfNormalizado = input.cpf.replace(/\D/g, "");
      const cpfKey = `${input.webhookId}:${cpfNormalizado}`;
      const existentePorCpf = offersByCpf.get(cpfKey);
      if (existentePorCpf) {
        const resetada: OfferRecord = {
          ...existentePorCpf,
          idempotencyKey: input.idempotencyKey,
          status: "RECEBIDO",
        };
        offersByCpf.set(cpfKey, resetada);
        offersByKey.set(`${input.webhookId}:${input.idempotencyKey}`, resetada);
        return { offer: resetada, kind: "reset" };
      }

      const compoundKey = `${input.webhookId}:${input.idempotencyKey}`;
      const existing = offersByKey.get(compoundKey);
      if (existing) {
        return { offer: existing, kind: "duplicate" };
      }
      counter += 1;
      const offer: OfferRecord = {
        id: `offer-${counter}`,
        webhookId: input.webhookId,
        idempotencyKey: input.idempotencyKey,
        status: "RECEBIDO",
        createdAt: new Date(0),
      };
      offersByKey.set(compoundKey, offer);
      offersByCpf.set(cpfKey, offer);
      return { offer, kind: "created" };
    },
  };

  return { port, offersByKey, offersByCpf };
}
