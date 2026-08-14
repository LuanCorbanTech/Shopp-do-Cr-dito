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
  /** "ofertas_v1" (esquema original) ou "hmac_sha256_simple" — ver apps/api/src/webhooks/hmac.ts. */
  esquemaAssinatura: string;
  /** Nome do header HTTP com a assinatura (minúsculo), ex.: "x-odysseia-signature". */
  headerAssinatura: string;
  /** Só usado no esquema "ofertas_v1" — null quando o esquema não tem timestamp/replay. */
  headerTimestamp: string | null;
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
  // Obrigatório desde que o CPF virou o campo de entrada exigido na captação (é a
  // partir dele que o Worker 1 consulta a Lemit — ver worker1-limit.ts).
  cpf: string;
  // Pode não vir na captação — nesse caso o telefone só aparece depois, quando a
  // Lemit devolve um a partir do CPF (telefoneAtualizado). Ver o guard em
  // worker2-whatsapp.ts para o caso em que nenhum telefone nunca aparece.
  telefoneOriginal: string | null;
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
