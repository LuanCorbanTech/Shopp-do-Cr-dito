import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  OffersPort,
  WebhookRecord,
  CreateOfferInput,
  CreateOfferResult,
  OfferRecord,
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
    // Pedido explícito: o MESMO fornecedor (webhookId) mandando o MESMO CPF
    // de novo nunca deve duplicar — reaproveita a oferta existente, com os
    // dados novos e todo o progresso resetado pro início do fluxo, não
    // importa em que status ela estava (mesmo já tendo dado certo antes).
    // Fornecedores DIFERENTES com o mesmo CPF continuam gerando ofertas
    // separadas normalmente (não checa isso globalmente, só por webhookId).
    const resetadas = await this.prisma.$queryRaw<OfferRecord[]>`
      UPDATE offers SET
        idempotency_key = ${input.idempotencyKey},
        external_id = ${input.externalId ?? null},
        nome = ${input.nome ?? null},
        telefone_original = ${input.telefoneOriginal},
        banco_autorizado = ${input.bancoAutorizado ?? null},
        produto = ${input.produto ?? null},
        valor = ${input.valor ?? null},
        parcelas = ${input.parcelas ?? null},
        payload_original = ${JSON.stringify(input.payloadOriginal)}::jsonb,
        dados_adicionais = ${input.dadosAdicionais != null ? JSON.stringify(input.dadosAdicionais) : null}::jsonb,
        status = 'RECEBIDO'::"OfferStatus",
        data_nascimento = NULL, sexo = NULL, nome_mae = NULL, email = NULL,
        telefone_lemit = NULL, whatsapp_lemit = NULL, endereco = NULL, uf = NULL,
        cep = NULL, bairro = NULL, cidade = NULL, numero = NULL, logradouro = NULL,
        complemento = NULL, telefone_atualizado = NULL, telefone_validado = NULL,
        possui_whatsapp = NULL, dados_pessoa_lemit = NULL,
        routing_rule_id = NULL, endpoint_id = NULL, campaign_id = NULL,
        reserved_at = NULL, tentativas_telefone = 0, tentativas_whatsapp = 0,
        tentativas_envio = 0, proxima_tentativa_em = NULL,
        whatsapp_request_id = NULL, whatsapp_check_iniciado_em = NULL,
        updated_at = now()
      WHERE webhook_id = ${input.webhookId} AND regexp_replace(cpf, '\\D', '', 'g') = regexp_replace(${input.cpf}, '\\D', '', 'g')
      RETURNING id, webhook_id AS "webhookId", idempotency_key AS "idempotencyKey", status, created_at AS "createdAt"
    `;
    if (resetadas.length > 0) {
      return { offer: resetadas[0], kind: "reset" };
    }

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
      return { offer, kind: "created" };
    } catch (error) {
      // Corrida rara: duas requisições simultâneas pro MESMO CPF novo (nenhuma
      // achou a outra no SELECT/UPDATE acima, ambas tentaram criar) — a
      // constraint única (webhookId, idempotencyKey) garante que só uma cria
      // de verdade; a outra cai aqui e devolve a que já foi criada.
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
          return { offer: existing, kind: "duplicate" };
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
