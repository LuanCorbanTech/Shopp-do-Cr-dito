import { logger, maskPhone } from "@plataforma-ofertas/shared";
import {
  nextAttemptDate,
  hasExceededMaxAttempts,
  extrairInfoPessoaLemit,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
  DEFAULT_MAX_TENTATIVAS,
  type PhoneProcessingPort,
  type IntegrationConfigPort,
} from "@plataforma-ofertas/domain";

// Worker 1 — Processamento inicial (itens 5-11 do escopo original).
// Se "LIMIT_CONSULTA" estiver desativado no painel, usa o telefone original sem
// nenhuma chamada externa (item 8) — a oferta nunca fica presa em RECEBIDO.
// Se estiver ativado, consulta a Lemit (packages/integrations/limit) por CPF —
// sem CPF não há como consultar, então esse caso também usa o telefone original
// direto, sem contar como falha/retry. Falhas de fato (erro de rede, API fora do
// ar) entram em retry com backoff, nunca infinito (item 28).

export interface LimitLookup {
  lookupPhone(params: { documento: string }): Promise<{
    telefoneAtualizado: string | null;
    possuiWhatsappSegundoLemit: boolean | null;
    dadosPessoa: Record<string, unknown> | null;
    respostaBruta: unknown;
  }>;
}

export interface RunLimitWorkerOnceParams {
  phonePort: PhoneProcessingPort;
  configPort: IntegrationConfigPort;
  limitService: LimitLookup;
  batchSize?: number;
  now?: Date;
}

export async function runLimitWorkerOnce(params: RunLimitWorkerOnceParams): Promise<number> {
  const { phonePort, configPort, limitService, batchSize = 20, now = new Date() } = params;

  const config = await configPort.getConfig("LIMIT_CONSULTA");
  const limitEnabled = config?.ativo ?? false;
  const maxTentativas = Number(config?.valor.maxTentativas ?? DEFAULT_MAX_TENTATIVAS);
  const schedule = Array.isArray(config?.valor.backoffSecondsSchedule)
    ? (config!.valor.backoffSecondsSchedule as number[])
    : DEFAULT_BACKOFF_SCHEDULE_SECONDS;

  const offers = await phonePort.claimOffersReceived(batchSize);

  for (const offer of offers) {
    if (!limitEnabled) {
      await phonePort.markPhoneSkippedLimitDisabled(offer.id);
      logger.info(
        { offerId: offer.id, telefone: maskPhone(offer.telefoneOriginal) },
        "Consulta Lemit ignorada: integração desativada no painel. Telefone original mantido."
      );
      continue;
    }

    if (!offer.cpf) {
      await phonePort.markPhoneSkippedSemDocumento(offer.id);
      logger.info(
        { offerId: offer.id, telefone: maskPhone(offer.telefoneOriginal) },
        "Consulta Lemit ignorada: lead sem CPF. Telefone original mantido."
      );
      continue;
    }

    const tentativa = offer.tentativasTelefone + 1;
    try {
      const result = await limitService.lookupPhone({ documento: offer.cpf });
      await phonePort.markPhoneUpdated(offer.id, {
        telefoneAtualizado: result.telefoneAtualizado ?? offer.telefoneOriginal,
        respostaBruta: result.respostaBruta,
        dadosPessoa: result.dadosPessoa,
        infoPessoa: extrairInfoPessoaLemit(result.dadosPessoa),
        possuiWhatsappSegundoLemit: result.possuiWhatsappSegundoLemit,
        tentativa,
      });
    } catch (error) {
      // Duck-typing de propósito (não importa LimitServiceError direto aqui,
      // mantém esse worker desacoplado do pacote de integração concreto,
      // testável com fakes) — LimitServiceError sempre tem essas propriedades.
      const respostaBruta =
        error && typeof error === "object" && "respostaBruta" in error
          ? (error as { respostaBruta: unknown }).respostaBruta
          : undefined;
      const httpStatus =
        error && typeof error === "object" && "httpStatus" in error ? (error as { httpStatus: unknown }).httpStatus : undefined;

      // 404 = a Lemit não tem registro pra esse CPF (diferente de erro
      // transitório) — terminal direto, sem entrar na fila de retry (ver
      // markPhoneCpfInvalido).
      if (httpStatus === 404) {
        await phonePort.markPhoneCpfInvalido(offer.id, respostaBruta);
        logger.warn(
          { offerId: offer.id, telefone: maskPhone(offer.telefoneOriginal) },
          "Lemit não encontrou registro pra esse CPF (404) — marcado como CPF inválido, sem retry."
        );
        continue;
      }

      const cancelar = hasExceededMaxAttempts(tentativa, maxTentativas);
      await phonePort.markPhoneFailed(offer.id, {
        erro: error instanceof Error ? error.message : String(error),
        tentativa,
        proximaTentativaEm: cancelar ? null : nextAttemptDate(tentativa, now, schedule),
        cancelar,
        respostaBruta,
      });
      logger.warn(
        { offerId: offer.id, telefone: maskPhone(offer.telefoneOriginal), tentativa, cancelar },
        "Falha na consulta à Lemit"
      );
    }
  }

  return offers.length;
}
