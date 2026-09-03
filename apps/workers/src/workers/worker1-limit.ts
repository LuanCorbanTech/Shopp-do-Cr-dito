import { logger, maskPhone } from "@plataforma-ofertas/shared";
import {
  nextAttemptDate,
  hasExceededMaxAttempts,
  extrairInfoPessoaLemit,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
  DEFAULT_MAX_TENTATIVAS,
  type PhoneProcessingPort,
  type IntegrationConfigPort,
  type OfferSnapshot,
} from "@plataforma-ofertas/domain";

// Worker 1 — Processamento inicial (itens 5-11 do escopo original).
// Se "LIMIT_CONSULTA" estiver desativado no painel, usa o telefone original sem
// nenhuma chamada externa (item 8) — a oferta nunca fica presa em RECEBIDO.
// Se estiver ativado, consulta a Lemit (packages/integrations/limit) por CPF —
// sem CPF não há como consultar, então esse caso também usa o telefone original
// direto, sem contar como falha/retry. Falhas de fato (erro de rede, API fora do
// ar) entram em retry com backoff, nunca infinito (item 28).
//
// Segunda chance (02/09, pedido explícito) — além da fila normal (RECEBIDO),
// esse worker também processa uma SEGUNDA fila: ofertas que ficaram
// SEM_WHATSAPP usando o telefone original (porque a Lemit estava desativada,
// ou o lead não tinha CPF na hora) e que NUNCA tiveram uma consulta de
// verdade à Lemit ainda (telefoneAtualizado nulo). Pra essas, o worker
// consulta a Lemit DE VERDADE mesmo que o interruptor geral esteja
// desativado — é uma segunda chance direcionada só pra quem falhou, não uma
// volta a consultar todo mundo. Se a Lemit devolver um telefone novo, a
// oferta volta pra TELEFONE_ATUALIZADO e o Worker 2 valida esse número novo
// no próximo ciclo. Se a Lemit também não achar WhatsApp pra esse número,
// telefoneAtualizado já não fica mais nulo (foi consultado), então essa
// oferta não entra de novo nessa segunda fila — sem loop infinito.

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

  const offersRecebidas = await phonePort.claimOffersReceived(batchSize);
  const offersSegundaChance = await phonePort.claimOffersSemWhatsappParaRetentarLemit(batchSize);

  async function processarOferta(offer: OfferSnapshot, forcarConsultaLemit: boolean): Promise<void> {
    if (!forcarConsultaLemit && !limitEnabled) {
      await phonePort.markPhoneSkippedLimitDisabled(offer.id);
      logger.info(
        { offerId: offer.id, telefone: maskPhone(offer.telefoneOriginal) },
        "Consulta Lemit ignorada: integração desativada no painel. Telefone original mantido."
      );
      return;
    }

    if (!offer.cpf) {
      await phonePort.markPhoneSkippedSemDocumento(offer.id);
      logger.info(
        { offerId: offer.id, telefone: maskPhone(offer.telefoneOriginal) },
        "Consulta Lemit ignorada: lead sem CPF. Telefone original mantido."
      );
      return;
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
      if (forcarConsultaLemit) {
        logger.info(
          { offerId: offer.id },
          "Segunda chance: Lemit consultada de verdade pra lead que tinha ficado sem WhatsApp — telefone atualizado, vai validar de novo"
        );
      }
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
        return;
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

  for (const offer of offersRecebidas) {
    await processarOferta(offer, false);
  }
  for (const offer of offersSegundaChance) {
    await processarOferta(offer, true);
  }

  return offersRecebidas.length + offersSegundaChance.length;
}
