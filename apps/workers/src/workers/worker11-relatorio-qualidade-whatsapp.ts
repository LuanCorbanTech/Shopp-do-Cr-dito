import { logger } from "@plataforma-ofertas/shared";

// Worker 11 — Relatório de Qualidade WhatsApp (11/09): SUBSTITUI o antigo
// alerta "só quando piora" do worker10 (decisão do usuário — não quer mais
// um alerta pontual por regressão, quer um retrato completo, periódico, de
// TODOS os números cadastrados). Ciclo e webhook são configurados à parte da
// consulta automática (worker10) — dois cronogramas independentes, cada um
// com sua própria frequência.
//
// A cada ciclo (se ativo e com webhook cadastrado): busca todos os números
// já registrados (todas as BMs/WABAs, sem filtro) e manda 1 POST só, com a
// lista inteira e a qualidade atual de cada um, já traduzida pro rótulo em
// português (alta/média/baixa/desconhecida — mesmos termos usados no
// painel). Falha ao enviar é só logada — nunca derruba nada, mesma
// filosofia "falha aberta" dos outros workers; no próximo ciclo tenta de
// novo com os dados atualizados.

export interface NumeroQualidadeParaRelatorio {
  phoneNumberId: string;
  displayPhoneNumber: string;
  /** Valor cru vindo da Meta (GREEN | YELLOW | RED | UNKNOWN) — traduzido pro rótulo em português aqui dentro. */
  qualityRating: string;
  wabaId: string;
  bmNome: string;
}

export interface RunRelatorioQualidadeWhatsappWorkerOnceParams {
  ativo: boolean;
  webhookUrl?: string | null;
  numeros: NumeroQualidadeParaRelatorio[];
  /** Injeção do fetch — só pra testar sem rede de verdade; em produção usa o fetch global. */
  fetchImpl?: typeof fetch;
}

// Mesmos rótulos usados no painel (item 1 do pedido de 11/09): Verde/Amarela/
// Vermelha viraram Alta/Média/Baixa — aqui em minúsculo e sem acento, pra não
// depender de encoding no corpo do POST. UNKNOWN nunca teve nome trocado.
const ROTULO_QUALIDADE: Record<string, string> = {
  GREEN: "alta",
  YELLOW: "media",
  RED: "baixa",
  UNKNOWN: "desconhecido",
};

export interface RelatorioQualidadeWhatsappBodyItem {
  phone_number_id: string;
  numero: string;
  bm: string;
  waba_id: string;
  qualidade: string;
}

export interface RelatorioQualidadeWhatsappBody {
  gerado_em: string;
  total_numeros: number;
  numeros: RelatorioQualidadeWhatsappBodyItem[];
}

export function montarRelatorioQualidadeWhatsappBody(
  numeros: NumeroQualidadeParaRelatorio[]
): RelatorioQualidadeWhatsappBody {
  return {
    gerado_em: new Date().toISOString(),
    total_numeros: numeros.length,
    numeros: numeros.map((n) => ({
      phone_number_id: n.phoneNumberId,
      numero: n.displayPhoneNumber,
      bm: n.bmNome,
      waba_id: n.wabaId,
      qualidade: ROTULO_QUALIDADE[n.qualityRating] ?? "desconhecido",
    })),
  };
}

export async function runRelatorioQualidadeWhatsappWorkerOnce(
  params: RunRelatorioQualidadeWhatsappWorkerOnceParams
): Promise<number> {
  const { ativo, webhookUrl, numeros, fetchImpl = fetch } = params;

  if (!ativo) return 0;
  if (!webhookUrl) {
    logger.warn("Relatório de qualidade WhatsApp ativado mas sem webhook cadastrado no painel — ciclo ignorado");
    return 0;
  }

  const body = montarRelatorioQualidadeWhatsappBody(numeros);

  try {
    const resposta = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resposta.ok) {
      logger.error(
        { webhookUrl, status: resposta.status },
        "Webhook do relatório de qualidade WhatsApp respondeu com erro"
      );
      return 0;
    }
    logger.info({ webhookUrl, totalNumeros: body.total_numeros }, "Relatório de qualidade WhatsApp enviado");
    return 1;
  } catch (error) {
    logger.error({ webhookUrl, error }, "Falha ao enviar o relatório de qualidade WhatsApp");
    return 0;
  }
}
