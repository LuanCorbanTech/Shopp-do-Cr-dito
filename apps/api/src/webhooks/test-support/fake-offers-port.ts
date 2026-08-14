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
} {
  const offersByKey = new Map<string, OfferRecord>();
  let counter = 0;

  const port: OffersPort = {
    async findActiveWebhookByIdentificador(identificador: string) {
      const webhook = webhooks.find((w) => w.identificador === identificador);
      if (!webhook || !webhook.ativo) return null;
      return webhook;
    },

    async createOfferIdempotent(input: CreateOfferInput): Promise<CreateOfferResult> {
      const compoundKey = `${input.webhookId}:${input.idempotencyKey}`;
      const existing = offersByKey.get(compoundKey);
      if (existing) {
        return { offer: existing, created: false };
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
      return { offer, created: true };
    },
  };

  return { port, offersByKey };
}
