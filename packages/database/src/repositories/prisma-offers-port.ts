import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  OffersPort,
  WebhookRecord,
  CreateOfferInput,
  CreateOfferResult,
  OfferRecord,
} from "@plataforma-ofertas/domain";

const UNIQUE_CONSTRAINT_ERROR_CODE = "P2002";

// Linha devolvida pelo INSERT ... ON CONFLICT ... RETURNING de
// createOfferIdempotent — igual a OfferRecord, mais o truque "(xmax = 0)"
// (ver comentário no método) pra saber se a linha foi INSERIDA ou
// ATUALIZADA sem precisar de uma 2ª consulta.
type LinhaUpsertOffer = OfferRecord & { inserted: boolean };

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
    // UPSERT atômico (14/09, substitui o antigo UPDATE-tenta-depois-INSERT):
    // 1 única ida ao banco resolve os 3 casos (criar / resetar / descartar).
    // O motivo de trocar: o padrão antigo pagava 2 round trips por CPF NOVO
    // (o UPDATE não achava nada, então caía no INSERT) — em lotes grandes
    // (ex.: ~500 leads da Odysseia) isso sozinho bastava pra estourar o
    // timeout de 50s do parceiro, mesmo já processando em paralelo.
    //
    // "id" é gerado aqui (não no banco) porque @default(uuid()) do Prisma é
    // só client-side — não existe pra um INSERT via SQL cru.
    //
    // ON CONFLICT usa o índice ÚNICO uq_offers_webhook_cpf_normalizado
    // (webhook_id, regexp_replace(cpf, '\D','','g')) — ver schema.prisma e a
    // migração 20260914130000. A cláusula WHERE do DO UPDATE é a regra de
    // negócio pedida explicitamente (14/09): só atualiza (reseta) se já
    // passaram mais de 24h desde ultimo_recebimento_webhook_em; se não
    // passaram, o Postgres PULA o update pra essa linha (documentado:
    // comporta-se como DO NOTHING) e o RETURNING não devolve nada — é assim
    // que detectamos "descartado" sem precisar de uma consulta a mais.
    //
    // "(xmax = 0) AS inserted" é o truque padrão do Postgres pra saber, no
    // mesmo RETURNING, se a linha foi INSERIDA (xmax = 0) ou ATUALIZADA por
    // um DO UPDATE (xmax = id da transação atual) — sem precisar de uma 2ª
    // consulta só pra descobrir created vs reset.
    const linhas = await this.prisma.$queryRaw<LinhaUpsertOffer[]>`
      INSERT INTO offers (
        id, webhook_id, idempotency_key, external_id, nome, cpf,
        telefone_original, banco_autorizado, produto, valor, parcelas,
        payload_original, dados_adicionais, status,
        pular_validacao_lemit, pular_validacao_whatsapp, lote_upload_id,
        ultimo_recebimento_webhook_em, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${input.webhookId}, ${input.idempotencyKey}, ${input.externalId ?? null},
        ${input.nome ?? null}, ${input.cpf},
        ${input.telefoneOriginal}, ${input.bancoAutorizado ?? null}, ${input.produto ?? null},
        ${input.valor ?? null}, ${input.parcelas ?? null},
        ${JSON.stringify(input.payloadOriginal)}::jsonb,
        ${input.dadosAdicionais != null ? JSON.stringify(input.dadosAdicionais) : null}::jsonb,
        'RECEBIDO'::"OfferStatus",
        ${input.pularValidacaoLemit ?? false}, ${input.pularValidacaoWhatsapp ?? false}, ${input.loteUploadId ?? null},
        now(), now(), now()
      )
      ON CONFLICT (webhook_id, (regexp_replace(cpf, '\\D', '', 'g')))
      DO UPDATE SET
        idempotency_key = EXCLUDED.idempotency_key,
        external_id = EXCLUDED.external_id,
        nome = EXCLUDED.nome,
        telefone_original = EXCLUDED.telefone_original,
        banco_autorizado = EXCLUDED.banco_autorizado,
        produto = EXCLUDED.produto,
        valor = EXCLUDED.valor,
        parcelas = EXCLUDED.parcelas,
        payload_original = EXCLUDED.payload_original,
        dados_adicionais = EXCLUDED.dados_adicionais,
        status = 'RECEBIDO'::"OfferStatus",
        -- Base de upload (18/09): a oferta reaproveitada passa a valer com as
        -- flags/lote da submissão NOVA (a que está resetando agora) - se um
        -- parceiro webhook reenviar um CPF que tinha vindo de upload antes,
        -- volta a false/null (webhook nunca seta essas colunas); se for outro
        -- upload resetando, usa as flags desse lote novo.
        pular_validacao_lemit = EXCLUDED.pular_validacao_lemit,
        pular_validacao_whatsapp = EXCLUDED.pular_validacao_whatsapp,
        lote_upload_id = EXCLUDED.lote_upload_id,
        data_nascimento = NULL, sexo = NULL, nome_mae = NULL, email = NULL,
        telefone_lemit = NULL, whatsapp_lemit = NULL, endereco = NULL, uf = NULL,
        cep = NULL, bairro = NULL, cidade = NULL, numero = NULL, logradouro = NULL,
        complemento = NULL, telefone_atualizado = NULL, telefone_validado = NULL,
        possui_whatsapp = NULL, dados_pessoa_lemit = NULL,
        routing_rule_id = NULL, endpoint_id = NULL, campaign_id = NULL,
        reserved_at = NULL, tentativas_telefone = 0, tentativas_whatsapp = 0,
        tentativas_envio = 0, proxima_tentativa_em = NULL,
        whatsapp_request_id = NULL, whatsapp_check_iniciado_em = NULL,
        disparo_enviado_em = NULL, disparo_respondido_em = NULL,
        disparo_consultado_em = NULL,
        ultimo_recebimento_webhook_em = now(),
        updated_at = now()
      WHERE offers.ultimo_recebimento_webhook_em < now() - interval '24 hours'
      RETURNING id, webhook_id AS "webhookId", idempotency_key AS "idempotencyKey", status, created_at AS "createdAt", (xmax = 0) AS inserted
    `.catch((error: unknown) => {
      // Corrida rara: duas requisições simultâneas pro MESMO CPF novo, OU
      // um retry com a mesma idempotencyKey de uma oferta JÁ CRIADA por
      // outro webhookId (o ON CONFLICT acima só cobre o conflito por
      // CPF+webhook; a constraint única (webhookId, idempotencyKey) ainda
      // pode disparar aqui) — devolve a que já existe, sem duplicar.
      if (this.isUniqueConstraintError(error)) {
        return "duplicate" as const;
      }
      throw error;
    });

    if (linhas === "duplicate") {
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
      // Não deveria acontecer (a constraint que disparou o erro garante que
      // existe), mas se por algum motivo não achar, propaga como erro real
      // em vez de mascarar um estado inconsistente.
      throw new Error("Conflito de idempotência detectado, mas a oferta existente não foi encontrada.");
    }

    if (linhas.length === 0) {
      // Conflito por (webhookId, CPF) existiu, mas ainda dentro da janela de
      // 24h — o Postgres pulou o UPDATE (WHERE falso) e não devolveu nada.
      // Descarta: nenhuma mudança na oferta existente, só registra 1 evento
      // pro contador "total geral" do painel (pedido explícito 14/09).
      await this.prisma.webhookLeadDescartado.create({ data: { webhookId: input.webhookId } });
      return { kind: "discarded" };
    }

    const linha = linhas[0];
    const { inserted, ...offer } = linha;
    return { offer, kind: inserted ? "created" : "reset" };
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
