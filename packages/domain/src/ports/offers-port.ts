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

export type CreateOfferResult =
  | {
      offer: OfferRecord;
      /**
       * "created": CPF novo pra esse webhook, oferta criada do zero.
       * "reset": já existia uma oferta com esse CPF NESSE MESMO webhook, e
       * já tinham passado mais de 24h desde a última vez que ela foi
       * ACEITA (criada ou resetada — nunca um descarte) — reaproveitada em
       * vez de duplicar: dados atualizados com o que chegou agora, e todo o
       * progresso (status, telefone validado, tentativas, etc.) voltou pro
       * início do fluxo, como se fosse processada pela primeira vez.
       * Pedido explícito (14/09): dentro de 24h descarta (ver "discarded"
       * abaixo); só depois de 24h é que reseta e deixa entrar no fluxo de
       * novo.
       * "duplicate": caso raríssimo de corrida (duas requisições
       * simultâneas exatamente idênticas, mesma idempotencyKey, disputando
       * a mesma inserção) — devolve a que já foi criada pela outra, sem
       * duplicar nem resetar de novo.
       */
      kind: "created" | "reset" | "duplicate";
    }
  | {
      /**
       * "discarded" (14/09): já existia uma oferta com esse CPF nesse mesmo
       * webhook, e ainda NÃO tinham passado 24h desde a última vez que ela
       * foi aceita — pedido explícito do cliente. A oferta existente não é
       * tocada em nada (nenhum progresso, ex.: WhatsApp já validado, é
       * perdido) e nenhuma oferta nova é criada; só fica registrado 1
       * evento de descarte (ver WebhookLeadDescartado, usado só pra um
       * contador "total geral" no painel). Um descarte NUNCA renova a
       * janela de 24h — "a contagem fica sendo a última que ele de fato
       * passou pelo funil" (confirmado explicitamente).
       */
      kind: "discarded";
    };

export interface OffersPort {
  findActiveWebhookByIdentificador(identificador: string): Promise<WebhookRecord | null>;
  createOfferIdempotent(input: CreateOfferInput): Promise<CreateOfferResult>;
}
