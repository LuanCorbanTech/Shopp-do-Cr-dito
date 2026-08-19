import { logger, maskPhone } from "@plataforma-ofertas/shared";
import {
  decideWhatsappCheckFailureOutcome,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
  DEFAULT_MAX_TENTATIVAS,
  type WhatsappValidationPort,
  type IntegrationConfigPort,
} from "@plataforma-ofertas/domain";

// Worker 2 — Validação WhatsApp (item 12 do escopo original).
// Usa telefone_atualizado se o Limit rodou; senão cai para telefone_original —
// a decisão "qual telefone usar" já foi resolvida pelo Worker 1 (item 12: "EM AMBOS OS
// CASOS -> validar WhatsApp").
//
// A API de validação da CorbanTech é assíncrona (docs/integrations/
// APIValidacaoWhatsAppCorbanTech.pdf): iniciar a consulta só devolve um request_id
// (HTTP 202); o resultado chega depois. Este worker tem duas fases a cada ciclo:
//   1) Inicia consultas novas para ofertas recém-reservadas (TELEFONE_ATUALIZADO ->
//      VALIDANDO_WHATSAPP), guardando o request_id.
//   2) Busca manualmente (fallback) o resultado de ofertas que ficaram esperando
//      demais sem o webhook chegar (ver apps/api/src/webhooks/whatsapp-validacao
//      para o caminho "rápido", via callback). O request_id fica disponível na
//      CorbanTech por 14 dias, então esse fallback funciona mesmo que o webhook
//      falhe ou o endpoint fique fora do ar temporariamente.

export interface WhatsappValidator {
  startCheck(params: { phone: string }): Promise<{ requestId: string; phone: string }>;
  getCheckResult(
    requestId: string
  ): Promise<{ status: "processing" | "done" | "error"; hasWhatsapp?: boolean; message?: string }>;
  /**
   * Consulta em LOTE (mínimo 500 números) — bem mais barata por número que
   * startCheck/getCheckResult (que usam a eKYC Pro), em troca de não ser
   * instantânea. Ver runWhatsappWorkerOnce: o worker acumula ofertas até ter
   * volume suficiente antes de chamar isso.
   */
  startCheckLote(params: { phones: string[] }): Promise<{ loteId: string; total: number }>;
  getCheckResultLote(
    loteId: string
  ): Promise<{
    status: "processing" | "done" | "error";
    resultados?: { telefone: string; possuiWhatsapp: boolean }[];
    message?: string;
  }>;
}

export interface RunWhatsappWorkerOnceParams {
  whatsappPort: WhatsappValidationPort;
  configPort: IntegrationConfigPort;
  whatsappService: WhatsappValidator;
  batchSize?: number;
  /** Depois de quanto tempo sem resposta um request_id é considerado "atrasado" e buscado manualmente. */
  awaitingResultTimeoutMs?: number;
  /** Quantas ofertas esperando são necessárias pra disparar um lote (mínimo real da checknumber.ai: 500). */
  loteMinimo?: number;
  /** Teto de segurança pro tamanho de 1 lote só (corpo da requisição não cresce sem limite). */
  loteMaximo?: number;
  /**
   * Tempo máximo que a oferta mais antiga pode esperar acumulando pra um
   * lote — se passar disso sem juntar `loteMinimo`, usa o caminho
   * individual (eKYC Pro, mais caro) como plano B, pra nunca deixar
   * oferta presa esperando um lote que demora demais pra se formar.
   */
  tempoMaximoEsperaLoteMs?: number;
  now?: Date;
}

export async function runWhatsappWorkerOnce(params: RunWhatsappWorkerOnceParams): Promise<number> {
  const {
    whatsappPort,
    configPort,
    whatsappService,
    batchSize = 20,
    awaitingResultTimeoutMs = 90_000,
    loteMinimo = 500,
    loteMaximo = 5000,
    tempoMaximoEsperaLoteMs = 2 * 60 * 60 * 1000, // 2h — ver comentário na interface
    now = new Date(),
  } = params;

  const config = await configPort.getConfig("WHATSAPP_VALIDACAO");
  const maxTentativas = Number(config?.valor.maxTentativas ?? DEFAULT_MAX_TENTATIVAS);
  const schedule = Array.isArray(config?.valor.backoffSecondsSchedule)
    ? (config!.valor.backoffSecondsSchedule as number[])
    : DEFAULT_BACKOFF_SCHEDULE_SECONDS;

  let processadas = 0;

  // Processa uma oferta pelo caminho INDIVIDUAL (eKYC Pro) — usado tanto
  // quando o lote não é a estratégia certa (volume baixo, dentro do prazo
  // aceitável — nesse caso a Fase 1 nem chama isso) quanto no plano B de
  // overflow (esperou demais sem juntar volume pro lote).
  async function iniciarConsultaIndividual(offer: Awaited<ReturnType<typeof whatsappPort.claimOffersForValidation>>[number]) {
    const telefoneUsado = offer.telefoneAtualizado ?? offer.telefoneOriginal;
    if (!telefoneUsado) {
      await whatsappPort.markWhatsappFailed(offer.id, {
        erro: "Nenhum telefone disponível: não veio na captação e a Lemit não retornou um para esse CPF.",
        tentativa: offer.tentativasWhatsapp + 1,
        proximaTentativaEm: null,
        cancelar: true,
      });
      logger.warn(
        { offerId: offer.id },
        "Validação de WhatsApp cancelada: lead sem telefone (nem na captação, nem via Lemit)"
      );
      processadas += 1;
      return;
    }
    try {
      const startResult = await whatsappService.startCheck({ phone: telefoneUsado });
      await whatsappPort.markWhatsappCheckStarted(offer.id, {
        requestId: startResult.requestId,
        telefoneUsado,
        respostaBruta: startResult,
      });
      processadas += 1;
    } catch (error) {
      const outcome = decideWhatsappCheckFailureOutcome({
        tentativaAtual: offer.tentativasWhatsapp,
        maxTentativas,
        backoffSchedule: schedule,
        now,
      });
      await whatsappPort.markWhatsappFailed(offer.id, {
        erro: error instanceof Error ? error.message : String(error),
        tentativa: outcome.tentativa,
        proximaTentativaEm: outcome.proximaTentativaEm,
        cancelar: outcome.cancelar,
      });
      logger.warn(
        { offerId: offer.id, telefone: maskPhone(telefoneUsado), tentativa: outcome.tentativa, cancelar: outcome.cancelar },
        "Falha ao iniciar consulta de WhatsApp"
      );
      processadas += 1;
    }
  }

  // Fase 1 — decide entre acumular, disparar um lote, ou usar o caminho
  // individual como plano B (overflow).
  const contagem = await whatsappPort.countOffersAwaitingValidation();
  if (contagem.total >= loteMinimo) {
    const tamanhoLote = Math.min(contagem.total, loteMaximo);
    const ofertas = await whatsappPort.claimOffersForValidation(tamanhoLote);

    // Ofertas sem telefone nenhum não entram no lote (mesma proteção do
    // caminho individual) — tratadas uma a uma, o resto segue pro lote.
    const semTelefone = ofertas.filter((o) => !(o.telefoneAtualizado ?? o.telefoneOriginal));
    const comTelefone = ofertas.filter((o) => o.telefoneAtualizado ?? o.telefoneOriginal);
    for (const offer of semTelefone) {
      await whatsappPort.markWhatsappFailed(offer.id, {
        erro: "Nenhum telefone disponível: não veio na captação e a Lemit não retornou um para esse CPF.",
        tentativa: offer.tentativasWhatsapp + 1,
        proximaTentativaEm: null,
        cancelar: true,
      });
      processadas += 1;
    }

    if (comTelefone.length > 0) {
      const telefones = comTelefone.map((o) => (o.telefoneAtualizado ?? o.telefoneOriginal) as string);
      try {
        const { loteId } = await whatsappService.startCheckLote({ phones: telefones });
        await whatsappPort.markWhatsappLoteCheckStarted({ offerIds: comTelefone.map((o) => o.id), loteId });
        processadas += comTelefone.length;
        logger.info({ loteId, total: comTelefone.length }, "Lote de validação de WhatsApp iniciado");
      } catch (error) {
        // Falha ao INICIAR o lote inteiro (ex.: serviço fora do ar) — agenda
        // retry pra todas as ofertas desse lote, mesma lógica de backoff do
        // caminho individual.
        for (const offer of comTelefone) {
          const outcome = decideWhatsappCheckFailureOutcome({
            tentativaAtual: offer.tentativasWhatsapp,
            maxTentativas,
            backoffSchedule: schedule,
            now,
          });
          await whatsappPort.markWhatsappFailed(offer.id, {
            erro: error instanceof Error ? error.message : String(error),
            tentativa: outcome.tentativa,
            proximaTentativaEm: outcome.proximaTentativaEm,
            cancelar: outcome.cancelar,
          });
        }
        logger.warn({ error: error instanceof Error ? error.message : String(error), total: comTelefone.length }, "Falha ao iniciar lote de validação de WhatsApp");
        processadas += comTelefone.length;
      }
    }
  } else if (
    contagem.total > 0 &&
    contagem.esperandoDesde &&
    now.getTime() - contagem.esperandoDesde.getTime() > tempoMaximoEsperaLoteMs
  ) {
    // Plano B: esperou demais sem juntar volume suficiente pro lote — usa o
    // caminho individual (mais caro, mas nunca deixa a oferta presa).
    const ofertas = await whatsappPort.claimOffersForValidation(Math.min(contagem.total, batchSize));
    logger.warn(
      { total: ofertas.length, esperandoDesde: contagem.esperandoDesde },
      "Volume insuficiente pra lote dentro do prazo — usando consulta individual como plano B"
    );
    for (const offer of ofertas) {
      await iniciarConsultaIndividual(offer);
    }
  }
  // else: ainda acumulando, dentro do prazo aceitável — não faz nada nesse ciclo.

  // Fase 2 — fallback: busca manualmente o resultado de quem está esperando demais
  // (o webhook deveria ter chegado e não chegou).
  const ofertasAtrasadas = await whatsappPort.findOffersAwaitingWhatsappResult({
    olderThanMs: awaitingResultTimeoutMs,
    limit: batchSize,
    now,
  });
  for (const offer of ofertasAtrasadas) {
    const telefoneUsado = offer.telefoneAtualizado ?? offer.telefoneOriginal;
    if (!offer.whatsappRequestId) continue; // defensivo — não deveria acontecer dado o filtro da query

    // Mesma proteção da Fase 1 — se por algum motivo o telefone não estiver mais
    // disponível (não deveria acontecer, já que ter um whatsappRequestId significa
    // que a Fase 1 já validou um telefone antes de iniciar a consulta).
    if (!telefoneUsado) {
      await whatsappPort.markWhatsappFailed(offer.id, {
        erro: "Fallback manual encontrou a oferta sem telefone disponível.",
        tentativa: offer.tentativasWhatsapp + 1,
        proximaTentativaEm: null,
        cancelar: true,
      });
      logger.warn({ offerId: offer.id }, "Validação de WhatsApp (fallback) cancelada: sem telefone disponível");
      processadas += 1;
      continue;
    }

    try {
      const resultado = await whatsappService.getCheckResult(offer.whatsappRequestId);
      if (resultado.status === "processing") {
        continue; // ainda genuinamente processando — não é falha, só não deu tempo.
      }
      if (resultado.status === "done") {
        await whatsappPort.markWhatsappValidated(offer.id, {
          possuiWhatsapp: Boolean(resultado.hasWhatsapp),
          respostaBruta: resultado,
          telefoneUsado,
        });
        logger.info(
          { offerId: offer.id, viaFallbackManual: true },
          "Resultado de WhatsApp recuperado por consulta manual (webhook não chegou a tempo)"
        );
      } else {
        const outcome = decideWhatsappCheckFailureOutcome({
          tentativaAtual: offer.tentativasWhatsapp,
          maxTentativas,
          backoffSchedule: schedule,
          now,
        });
        await whatsappPort.markWhatsappFailed(offer.id, {
          erro: resultado.message ?? "Validação de WhatsApp retornou erro",
          tentativa: outcome.tentativa,
          proximaTentativaEm: outcome.proximaTentativaEm,
          cancelar: outcome.cancelar,
          respostaBruta: resultado,
        });
      }
      processadas += 1;
    } catch (error) {
      logger.warn(
        { offerId: offer.id, error: error instanceof Error ? error.message : String(error) },
        "Falha ao buscar manualmente o resultado da validação de WhatsApp — tenta de novo no próximo ciclo"
      );
    }
  }

  // Fase 2-B — mesmo papel da Fase 2, mas pra LOTES (vários offerIds
  // compartilhando 1 loteId) — distribui o resultado telefone por telefone
  // assim que o lote terminar.
  const lotesAtrasados = await whatsappPort.findLotesAwaitingWhatsappResult({
    olderThanMs: awaitingResultTimeoutMs,
    limit: batchSize,
    now,
  });
  for (const loteId of lotesAtrasados) {
    try {
      const resultadoLote = await whatsappService.getCheckResultLote(loteId);
      if (resultadoLote.status === "processing") continue; // ainda processando, normal (pode levar minutos)

      const ofertasDoLote = await whatsappPort.findOffersByWhatsappLoteId(loteId);
      if (resultadoLote.status === "done" && resultadoLote.resultados) {
        const porTelefone = new Map(resultadoLote.resultados.map((r) => [r.telefone, r.possuiWhatsapp]));
        for (const offer of ofertasDoLote) {
          const telefoneUsado = (offer.telefoneAtualizado ?? offer.telefoneOriginal) as string;
          const possuiWhatsapp = porTelefone.get(telefoneUsado) ?? false;
          await whatsappPort.markWhatsappValidated(offer.id, {
            possuiWhatsapp,
            respostaBruta: { loteId, telefone: telefoneUsado, possuiWhatsapp },
            telefoneUsado,
          });
          processadas += 1;
        }
        logger.info({ loteId, total: ofertasDoLote.length }, "Resultado de lote de WhatsApp distribuído");
      } else {
        // Lote inteiro falhou — agenda retry (ou cancela) pra cada oferta,
        // mesma lógica de backoff do caminho individual.
        for (const offer of ofertasDoLote) {
          const outcome = decideWhatsappCheckFailureOutcome({
            tentativaAtual: offer.tentativasWhatsapp,
            maxTentativas,
            backoffSchedule: schedule,
            now,
          });
          await whatsappPort.markWhatsappFailed(offer.id, {
            erro: resultadoLote.message ?? "Validação de WhatsApp em lote retornou erro",
            tentativa: outcome.tentativa,
            proximaTentativaEm: outcome.proximaTentativaEm,
            cancelar: outcome.cancelar,
            respostaBruta: resultadoLote,
          });
          processadas += 1;
        }
        logger.warn({ loteId, total: ofertasDoLote.length }, "Lote de validação de WhatsApp retornou erro");
      }
    } catch (error) {
      logger.warn(
        { loteId, error: error instanceof Error ? error.message : String(error) },
        "Falha ao buscar manualmente o resultado do lote de WhatsApp — tenta de novo no próximo ciclo"
      );
    }
  }

  return processadas;
}
