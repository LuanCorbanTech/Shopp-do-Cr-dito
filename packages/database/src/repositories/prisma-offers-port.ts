import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  OffersPort,
  WebhookRecord,
  CreateOfferInput,
  CreateOfferResult,
} from "@plataforma-ofertas/domain";

const UNIQUE_CONSTRAINT_ERROR_CODE = "P2002";

/**
 * Implementação da porta OffersPort usando Prisma/PostgreSQL.
 * Único ponto do código de ingestão que conhece o Prisma Client —
 * a lógica de negócio do webhook (apps/api/src/webhooks/handler.ts) depende
 * só da interface OffersPort.
 */
export class PrismaOffersPort implements OffersPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findActiveWebhookByIdentificador(identificador: string): Promise<WebhookRecord | null> {
    const webhook = await this.prisma.webhook.findUnique({ where: { identificador } });
    if (!webhook || !webhook.ativo) return null;
    return webhook;
  }

  async createOfferIdempotent(input: CreateOfferInput): Promise<CreateOfferResult> {
    try {
      const offer = await this.prisma.offer.create({
        data: {
          webhookId: input.webhookId,
          idempotencyKey: input.idempotencyKey,
          externalId: input.externalId ?? null,
          nome: input.nome ?? null,
          cpf: input.cpf ?? null,
          telefoneOriginal: input.telefoneOriginal,
          bancoAutorizado: input.bancoAutorizado ?? null,
          produto: input.produto ?? null,
          valor: input.valor ?? null,
          parcelas: input.parcelas ?? null,
          payloadOriginal: input.payloadOriginal as Prisma.InputJsonValue,
          dadosAdicionais: (input.dadosAdicionais ?? undefined) as Prisma.InputJsonValue | undefined,
          status: "RECEBIDO",
        },
      });
      return { offer, created: true };
    } catch (error) {
      // Duas requisições simultâneas com a mesma idempotency_key: a constraint única
      // (webhookId, idempotencyKey) garante que só uma cria; a outra cai aqui e
      // devolve o registro existente em vez de duplicar (item 3 do escopo original).
      if (this.isUniqueConstraintError(error)) {
        const existing = await this.prisma.offer.findUnique({
          where: {
            webhookId_idempotencyKey: {
              webhookId: input.webhookId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) {
          return { offer: existing, created: false };
        }
      }
      throw error;
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === UNIQUE_CONSTRAINT_ERROR_CODE
    );
  }
}
