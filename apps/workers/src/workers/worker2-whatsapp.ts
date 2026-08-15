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
}

export interface RunWhatsappWorkerOnceParams {
  whatsappPort: WhatsappValidationPort;
  configPort: IntegrationConfigPort;
  whatsappService: WhatsappValidator;
  batchSize?: number;
  /** Depois de quanto tempo sem resposta um request_id é considerado "atrasado" e buscado manualmente. */
  awaitingResultTimeoutMs?: number;
  now?: Date;
}

export async function runWhatsappWorkerOnce(params: RunWhatsappWorkerOnceParams): Promise<number> {
  const {
    whatsappPort,
    configPort,
    whatsappService,
    batchSize = 20,
    awaitingResultTimeoutMs = 90_000,
    now = new Date(),
  } = params;

  const config = await configPort.getConfig("WHATSAPP_VALIDACAO");
  const maxTentativas = Number(config?.valor.maxTentativas ?? DEFAULT_MAX_TENTATIVAS);
  const schedule = Array.isArray(config?.valor.backoffSecondsSchedule)
    ? (config!.valor.backoffSecondsSchedule as number[])
    : DEFAULT_BACKOFF_SCHEDULE_SECONDS;

  let processadas = 0;

  // Fase 1 — inicia consultas novas.
  const novasOfertas = await whatsappPort.claimOffersForValidation(batchSize);
  for (const offer of novasOfertas) {
    const telefoneUsado = offer.telefoneAtualizado ?? offer.telefoneOriginal;

    // Pode acontecer do parceiro não mandar telefone na captação E a Lemit também
    // não devolver nenhum pra esse CPF (ou a integração da Lemit estar desativada
    // no painel) — nesse caso não existe telefone nenhum pra validar. Cancela de
    // forma explícita em vez de chamar a API da CorbanTech com um telefone vazio.
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
      continue;
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

  return processadas;
}
