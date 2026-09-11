import { logger } from "@plataforma-ofertas/shared";
import type { MetaPhoneNumberResult } from "../fornecedores/meta-qualidade-whatsapp";

// Worker 10 — Qualidade WhatsApp (10/09, simplificado em 11/09): a cada
// ciclo, pega TODAS as WABAs ativas de BMs ativas (ver
// AdminRepository.wabasQualidadeParaConsultar — sem lote/limite desde 11/09,
// pedido do usuário: consultar tudo sempre, não mais um rodízio por lote),
// consulta cada uma na Meta (GET /{WABA_ID}/phone_numbers) e grava o
// resultado (estado atual + 1 linha de histórico por número, pedido
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
// Alerta por webhook (11/09): o antigo alerta "só quando piora" foi
// SUBSTITUÍDO pelo relatório periódico completo (ver
// worker11-relatorio-qualidade-whatsapp.ts) — esse worker aqui não dispara
// mais webhook nenhum, só consulta e grava.

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
  wabasQualidadeParaConsultar(): Promise<WabaParaConsultar[]>;
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
  versaoGraphApi?: string;
  port: QualidadeWhatsappPort;
  metaService: MetaQualidadeService;
}

export interface RunQualidadeWhatsappWorkerOnceResultado {
  consultadas: number;
  erros: number;
}

export async function runQualidadeWhatsappWorkerOnce(
  params: RunQualidadeWhatsappWorkerOnceParams
): Promise<RunQualidadeWhatsappWorkerOnceResultado> {
  const { ativo, versaoGraphApi = "v21.0", port, metaService } = params;

  let consultadas = 0;
  let erros = 0;

  if (!ativo) return { consultadas, erros };

  const wabas = await port.wabasQualidadeParaConsultar();
  if (wabas.length === 0) return { consultadas, erros };

  for (const waba of wabas) {
    try {
      const numeros = await metaService.buscarNumeros({
        wabaId: waba.wabaId,
        tokenAcesso: waba.tokenAcesso,
        versaoGraphApi,
      });
      // "pioraram" continua sendo calculado aqui dentro (ver
      // AdminRepository.registrarConsultaWabaSucesso), mas não dispara mais
      // webhook nenhum — só alimenta o histórico e a mensagem do botão
      // "Testar agora" (painel). O alerta por webhook agora é o relatório
      // periódico completo (worker11), não mais um evento por piora.
      await port.registrarConsultaWabaSucesso({ wabaContaId: waba.id, numeros });
      consultadas += 1;
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

  return { consultadas, erros };
}
