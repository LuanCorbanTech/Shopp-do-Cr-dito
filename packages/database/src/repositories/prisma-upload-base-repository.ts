import type { PrismaClient } from "@prisma/client";
import type { UploadBasePort, LinhaLoteUploadSnapshot, ResultadoProcessamentoLinha } from "@plataforma-ofertas/domain";
import { PrismaOffersPort } from "./prisma-offers-port";

/**
 * Implementação da porta UploadBasePort (worker12-processar-lote-upload) —
 * ver comentário completo em packages/domain/src/ports/upload-base-ports.ts
 * e no schema.prisma (modelos LoteUpload/LoteUploadLinha).
 *
 * Reaproveita PrismaOffersPort.createOfferIdempotent por dentro — é o MESMO
 * caminho de criação/idempotência/descarte em 24h que o recebimento via
 * webhook usa, só trocando de onde vêm os dados (linha da planilha em vez
 * de corpo HTTP) e sempre com o webhookId da identidade única "Base Upload".
 */
export class PrismaUploadBaseRepository implements UploadBasePort {
  private readonly offersPort: PrismaOffersPort;

  constructor(private readonly prisma: PrismaClient) {
    this.offersPort = new PrismaOffersPort(prisma);
  }

  async claimLinhasPendentes(limit: number): Promise<LinhaLoteUploadSnapshot[]> {
    if (limit <= 0) return [];
    const rows = await this.prisma.$queryRaw<{ id: string; loteUploadId: string }[]>`
      UPDATE lote_upload_linhas
      SET status = 'PROCESSANDO'::"StatusLinhaUpload"
      WHERE id IN (
        SELECT id FROM lote_upload_linhas
        WHERE status = 'PENDENTE'::"StatusLinhaUpload"
        ORDER BY criado_em
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, lote_upload_id AS "loteUploadId"
    `;
    return rows;
  }

  async processarLinha(linhaId: string): Promise<ResultadoProcessamentoLinha> {
    const linha = await this.prisma.loteUploadLinha.findUnique({
      where: { id: linhaId },
      include: { loteUpload: true },
    });
    // Defensivo — não deveria acontecer (a linha só chega aqui depois de
    // claimLinhasPendentes ter encontrado ela de verdade).
    if (!linha) return "erro";

    const lote = linha.loteUpload;

    // Primeira linha desse lote a ser processada — sinaliza "em andamento"
    // pra tela "Subir Base" (idempotente: sem efeito nas próximas chamadas).
    await this.prisma.loteUpload.updateMany({
      where: { id: lote.id, status: "PENDENTE" },
      data: { status: "PROCESSANDO" },
    });

    const cpfLimpo = (linha.cpf ?? "").trim();
    const telefoneLimpo = (linha.telefone ?? "").trim();
    if (!cpfLimpo || !telefoneLimpo) {
      await this.finalizarLinha(linha.id, lote.id, {
        status: "INVALIDA",
        erro: !cpfLimpo ? "Linha sem CPF" : "Linha sem telefone",
        incrementoLote: { linhasInvalidas: { increment: 1 } },
      });
      return "invalida";
    }

    try {
      const resultado = await this.offersPort.createOfferIdempotent({
        webhookId: lote.webhookId,
        // Chave estável por LINHA (não por CPF) — evita que um reprocessamento
        // dessa mesma linha (ex.: worker reiniciado no meio) colida com a
        // constraint única (webhookId, idempotencyKey) de outra linha
        // qualquer; quem realmente decide criar/resetar/descartar é sempre o
        // índice único por CPF dentro de createOfferIdempotent, não isso aqui.
        idempotencyKey: `upload-linha:${linha.id}`,
        nome: linha.nome ?? null,
        cpf: cpfLimpo,
        telefoneOriginal: telefoneLimpo,
        payloadOriginal: { origem: "upload", loteUploadId: lote.id, linhaId: linha.id },
        dadosAdicionais: linha.dadosExtras ?? null,
        pularValidacaoLemit: lote.pularValidacaoLemit,
        pularValidacaoWhatsapp: lote.pularValidacaoWhatsapp,
        loteUploadId: lote.id,
      });

      if (resultado.kind === "discarded") {
        await this.finalizarLinha(linha.id, lote.id, {
          status: "DESCARTADA",
          incrementoLote: { ofertasDescartadas: { increment: 1 } },
        });
        return "descartada";
      }

      // "created", "reset" e "duplicate" (corrida raríssima, ver comentário
      // em CreateOfferResult) todos têm uma oferta de verdade pra apontar —
      // "duplicate" conta como "resetada" pra fins de contador do painel,
      // não merece um balde próprio só pra um caso de corrida.
      const statusLinha = resultado.kind === "created" ? "CRIADA" : "RESETADA";
      await this.finalizarLinha(linha.id, lote.id, {
        status: statusLinha,
        ofertaId: resultado.offer.id,
        incrementoLote:
          resultado.kind === "created"
            ? { ofertasCriadas: { increment: 1 } }
            : { ofertasResetadas: { increment: 1 } },
      });
      return resultado.kind === "created" ? "criada" : "resetada";
    } catch (error) {
      await this.finalizarLinha(linha.id, lote.id, {
        status: "ERRO",
        erro: error instanceof Error ? error.message : String(error),
        incrementoLote: {},
      });
      return "erro";
    }
  }

  // Atualiza a linha (status final) e os contadores do lote numa única
  // transação, e verifica se era a última linha pendente desse lote — se
  // for, marca o lote inteiro como CONCLUIDO.
  private async finalizarLinha(
    linhaId: string,
    loteId: string,
    params: {
      status: "CRIADA" | "RESETADA" | "DESCARTADA" | "INVALIDA" | "ERRO";
      ofertaId?: string;
      erro?: string;
      incrementoLote: Record<string, { increment: number }>;
    }
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.loteUploadLinha.update({
        where: { id: linhaId },
        data: {
          status: params.status,
          ofertaId: params.ofertaId ?? null,
          erro: params.erro ?? null,
          processadoEm: new Date(),
        },
      }),
      this.prisma.loteUpload.update({
        where: { id: loteId },
        data: {
          linhasProcessadas: { increment: 1 },
          ...params.incrementoLote,
        },
      }),
    ]);

    const restantes = await this.prisma.loteUploadLinha.count({
      where: { loteUploadId: loteId, status: { in: ["PENDENTE", "PROCESSANDO"] } },
    });
    if (restantes === 0) {
      await this.prisma.loteUpload.updateMany({
        where: { id: loteId, status: { not: "CONCLUIDO" } },
        data: { status: "CONCLUIDO", concluidoEm: new Date() },
      });
    }
  }
}
