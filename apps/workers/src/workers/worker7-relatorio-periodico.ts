import { logger } from "@plataforma-ofertas/shared";

// Worker 7 — Relatório periódico. Diferente dos workers 1-6, este não manipula
// estado de ofertas através das portas do pipeline (não precisa — só lê contagens
// já prontas do dashboard) e não chama nenhuma API externa parceira: o único
// trabalho dele é montar o relatório do dia e enviar via POST simples pro
// endpoint que o usuário cadastrar no painel ("Integrações"). Por isso é uma
// função pura (sem porta/interface própria), recebendo já resolvidos: se está
// ativo, a URL de destino, e as contagens do dia — tudo isso é resolvido em
// apps/workers/src/index.ts (config lida do banco a cada ciclo, igual aos
// outros workers; contagens vindas de AdminRepository.dashboardKpis, a mesma
// consulta que alimenta os cards do Dashboard).

export interface RelatorioPeriodicoKpis {
  totalRecebidas: number;
  aguardandoProcessamento: number;
  limiteValidado: number;
  whatsappValidado: number;
  aguardandoConsultaDisparo: number;
  disparoConsultado: number;
  disparoEnviado: number;
  disparoRespondido: number;
}

export interface RunRelatorioPeriodicoWorkerOnceParams {
  ativo: boolean;
  endpointUrl?: string | null;
  kpis: RelatorioPeriodicoKpis;
  /** Injeção do fetch — só pra testar sem rede de verdade; em produção usa o fetch global. */
  fetchImpl?: typeof fetch;
}

// Nomes EXATOS pedidos pelo usuário — o endpoint que ele for cadastrar espera
// essas 9 chaves, nesse texto, sempre com os dados de HOJE (em Brasília).
export interface RelatorioPeriodicoBody {
  "Total de ofertas recebidas": number;
  "Aguardando processamento": number;
  "Com Lemit validado": number;
  "Com Whatsapp validado": number;
  "Aguardando consulta do disparo": number;
  "Com disparo consultado": number;
  "Disparo enviado": number;
  "Disparo respondido": number;
  "Taxa de resposta": number;
}

export function montarRelatorioPeriodicoBody(kpis: RelatorioPeriodicoKpis): RelatorioPeriodicoBody {
  const taxaResposta = kpis.disparoEnviado > 0 ? kpis.disparoRespondido / kpis.disparoEnviado : 0;
  return {
    "Total de ofertas recebidas": kpis.totalRecebidas,
    "Aguardando processamento": kpis.aguardandoProcessamento,
    "Com Lemit validado": kpis.limiteValidado,
    "Com Whatsapp validado": kpis.whatsappValidado,
    "Aguardando consulta do disparo": kpis.aguardandoConsultaDisparo,
    "Com disparo consultado": kpis.disparoConsultado,
    "Disparo enviado": kpis.disparoEnviado,
    "Disparo respondido": kpis.disparoRespondido,
    "Taxa de resposta": taxaResposta,
  };
}

export async function runRelatorioPeriodicoWorkerOnce(params: RunRelatorioPeriodicoWorkerOnceParams): Promise<number> {
  const { ativo, endpointUrl, kpis, fetchImpl = fetch } = params;

  if (!ativo) return 0;
  if (!endpointUrl) {
    logger.warn("Relatório periódico ativado mas sem endpoint cadastrado no painel — ciclo ignorado");
    return 0;
  }

  const body = montarRelatorioPeriodicoBody(kpis);

  try {
    const resposta = await fetchImpl(endpointUrl, {
      method: "POST",
      // Só este header, exatamente como pedido — nada de Authorization ou
      // outro header extra aqui (o endpoint é do próprio usuário).
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resposta.ok) {
      logger.error(
        { endpointUrl, status: resposta.status },
        "Endpoint do relatório periódico respondeu com erro"
      );
      return 0;
    }
    logger.info({ endpointUrl }, "Relatório periódico enviado");
    return 1;
  } catch (error) {
    logger.error({ endpointUrl, error }, "Falha ao enviar o relatório periódico");
    return 0;
  }
}
