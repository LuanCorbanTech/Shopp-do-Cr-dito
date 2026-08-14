// Porta (interface) que a camada de aplicação (API/handlers) usa para persistir ofertas.
// A implementação concreta (Prisma) vive em @plataforma-ofertas/database e é injetada em
// tempo de wiring (apps/api/src/server.ts). Isso mantém a lógica de negócio do webhook
// testável sem depender do Prisma Client gerado.

export interface WebhookRecord {
  id: string;
  identificador: string;
  origem: string;
  secretHmac: string;
  ativo: boolean;
}

export interface OfferRecord {
  id: string;
  webhookId: string;
  idempotencyKey: string;
  status: string;
  createdAt: Date;
}

export interface CreateOfferInput {
  webhookId: string;
  idempotencyKey: string;
  externalId?: string | null;
  nome?: string | null;
  cpf?: string | null;
  telefoneOriginal: string;
  bancoAutorizado?: string | null;
  produto?: string | null;
  valor?: number | null;
  parcelas?: number | null;
  payloadOriginal: unknown;
  dadosAdicionais?: unknown | null;
}

export interface CreateOfferResult {
  offer: OfferRecord;
  /** false quando a oferta já existia (idempotência) — nenhum registro novo foi criado. */
  created: boolean;
}

export interface OffersPort {
  findActiveWebhookByIdentificador(identificador: string): Promise<WebhookRecord | null>;
  createOfferIdempotent(input: CreateOfferInput): Promise<CreateOfferResult>;
}
