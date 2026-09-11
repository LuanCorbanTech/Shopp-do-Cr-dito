import { logger } from "@plataforma-ofertas/shared";
import type { MetaPhoneNumberResult } from "../fornecedores/meta-qualidade-whatsapp";

// Worker 10 — Qualidade WhatsApp (10/09): a cada ciclo, pega até `batchSize`
// WABAs ativas (as mais desatualizadas primeiro — ver
// AdminRepository.wabasQualidadeParaConsultar, ORDER BY ultima_consulta_em
// ASC NULLS FIRST), consulta cada uma na Meta (GET /{WABA_ID}/phone_numbers)
// e grava o resultado (estado atual + 1 linha de histórico por número, pedido
// explícito pra poder ver evolução — ver AdminRepository.registrarConsultaWabaSucesso).
//
// Cada WABA usa o TOKEN DA BM que é dona dela (o app é criado dentro da
// própria BM — 1 token por BM, N WABAs por BM) — por isso o token não é
// passado direto aqui: quem resolve token+WABA_ID é o repositório
// (wabasQualidadeParaConsultar já devolve os dois juntos).
//
// Uma WABA com erro (token expirado, WABA_ID inválido, rede) nunca derruba o
// ciclo inteiro — só essa WABA fica marcada com o erro (visível no painel) e
// o worker segue pras próximas, mesma filosofia de "falha aberta" dos outros
// workers.
//
// Alerta (painel + webhook, decisão de 10/09): quando um número piora nessa
// consulta (ver avaliarPioraQualidade em @plataforma-ofertas/domain, aplicado
// dentro de registrarConsultaWabaSucesso), e há uma URL de webhook
// configurada no painel, dispara 1 POST por número que piorou. Falha ao
// enviar o alerta é só logada — nunca refaz a consulta nem derruba o ciclo
// por causa disso.

export interface WabaParaConsultar {
  id: string;
  wabaId: string;
  bmContaId: string;
  bmNome: string;
  tokenAcesso: string;
}

export interface NumeroWhatsappPiorou {
  numeroId: string;
  displayPhoneNumber: string;
  wabaId: string;
  bmNome: string;
  motivo: string;
  qualityRatingAnterior: string | null;
  qualityRatingAtual: string;
}

export interface QualidadeWhatsappPort {
  wabasQualidadeParaConsultar(limite: number): Promise<WabaParaConsultar[]>;
  registrarConsultaWabaSucesso(params: {
    wabaContaId: string;
    numeros: MetaPhoneNumberResult[];
  }): Promise<{ pioraram: NumeroWhatsappPiorou[] }>;
  registrarConsultaWabaErro(wabaContaId: string, mensagem: string): Promise<void>;
}

export interface MetaQualidadeService {
  buscarNumeros(params: { wabaId: string; tokenAcesso: string; versaoGraphApi: string }): Promise<MetaPhoneNumberResult[]>;
}

export interface RunQualidadeWhatsappWorkerOnceParams {
  ativo: boolean;
  batchSize?: number;
  versaoGraphApi?: string;
  webhookAlertaUrl?: string | null;
  port: QualidadeWhatsappPort;
  metaService: MetaQualidadeService;
  /** Injeção do fetch — só pra testar sem rede de verdade; em produção usa o fetch global. */
  fetchImpl?: typeof fetch;
}

export interface RunQualidadeWhatsappWorkerOnceResultado {
  consultadas: number;
  erros: number;
  alertasEnviados: number;
}

async function enviarAlertaPiora(fetchImpl: typeof fetch, url: string, piora: NumeroWhatsappPiorou): Promise<boolean> {
  try {
    const resposta = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tipo: "qualidade_whatsapp_piorou",
        numeroId: piora.numeroId,
        telefone: piora.displayPhoneNumber,
        wabaId: piora.wabaId,
        bm: piora.bmNome,
        motivo: piora.motivo,
        qualityRatingAnterior: piora.qualityRatingAnterior,
        qualityRatingAtual: piora.qualityRatingAtual,
        consultadoEm: new Date().toISOString(),
      }),
    });
    if (!resposta.ok) {
      logger.error(
        { url, status: resposta.status, numeroId: piora.numeroId },
        "Webhook de alerta de qualidade WhatsApp respondeu com erro"
      );
      return false;
    }
    return true;
  } catch (error) {
    logger.error({ url, numeroId: piora.numeroId, error }, "Falha ao enviar webhook de alerta de qualidade WhatsApp");
    return false;
  }
}

export async function runQualidadeWhatsappWorkerOnce(
  params: RunQualidadeWhatsappWorkerOnceParams
): Promise<RunQualidadeWhatsappWorkerOnceResultado> {
  const {
    ativo,
    batchSize = 10,
    versaoGraphApi = "v21.0",
    webhookAlertaUrl,
    port,
    metaService,
    fetchImpl = fetch,
  } = params;

  let consultadas = 0;
  let erros = 0;
  let alertasEnviados = 0;

  if (!ativo) return { consultadas, erros, alertasEnviados };

  const wabas = await port.wabasQualidadeParaConsultar(batchSize);
  if (wabas.length === 0) return { consultadas, erros, alertasEnviados };

  for (const waba of wabas) {
    try {
      const numeros = await metaService.buscarNumeros({
        wabaId: waba.wabaId,
        tokenAcesso: waba.tokenAcesso,
        versaoGraphApi,
      });
      const { pioraram } = await port.registrarConsultaWabaSucesso({ wabaContaId: waba.id, numeros });
      consultadas += 1;

      if (webhookAlertaUrl && pioraram.length > 0) {
        for (const piora of pioraram) {
          const ok = await enviarAlertaPiora(fetchImpl, webhookAlertaUrl, piora);
          if (ok) alertasEnviados += 1;
        }
      }
    } catch (error) {
      erros += 1;
      const mensagem = error instanceof Error ? error.message : String(error);
      await port.registrarConsultaWabaErro(waba.id, mensagem);
      logger.error(
        { worker: "worker10-qualidade-whatsapp", wabaId: waba.wabaId, bmNome: waba.bmNome, error: mensagem },
        "Falha ao consultar qualidade da WABA na Meta"
      );
    }
  }

  return { consultadas, erros, alertasEnviados };
}
