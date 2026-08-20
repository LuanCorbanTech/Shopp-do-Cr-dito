import { logger } from "@plataforma-ofertas/shared";
import { estaDentroDaJanelaDeEnvio } from "@plataforma-ofertas/domain";

// Worker 7 — Relatório periódico. Diferente dos workers 1-6, este não manipula
// estado de ofertas através das portas do pipeline (não precisa — só lê contagens
// já prontas do dashboard) e não chama nenhuma API externa parceira: o único
// trabalho dele é montar o relatório do dia e enviar via POST simples pro
// endpoint que o usuário cadastrar no painel ("Integrações"). Por isso é uma
// função pura (sem porta/interface própria), recebendo já resolvidos: se está
// ativo, a URL de destino, a janela de horário permitida, e as contagens do dia
// — tudo isso é resolvido em apps/workers/src/index.ts (config lida do banco a
// cada ciclo, igual aos outros workers; contagens vindas de
// AdminRepository.dashboardKpis, a mesma consulta que alimenta os cards do
// Dashboard).

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
  /** "HH:MM" — início/fim da janela de horário permitida pro envio (em Brasília). Sem os dois, envia a qualquer hora. */
  horaInicio?: string | null;
  horaFim?: string | null;
  /** Instante usado pra checar a janela de horário — só pra testar; em produção usa o agora de verdade. */
  agora?: Date;
  /** Injeção do fetch — só pra testar sem rede de verdade; em produção usa o fetch global. */
  fetchImpl?: typeof fetch;
}

// Nomes pedidos pelo usuário, com "_" no lugar do espaço (o Hyperflow, do
// lado de quem recebe, não aceita chave de JSON com espaço) — o endpoint
// cadastrado espera essas 9 chaves, nesse texto, sempre com os dados de HOJE
// (em Brasília).
export interface RelatorioPeriodicoBody {
  Total_de_ofertas_recebidas: number;
  Aguardando_processamento: number;
  Com_Lemit_validado: number;
  Com_Whatsapp_validado: number;
  Aguardando_consulta_do_disparo: number;
  Com_disparo_consultado: number;
  Disparo_enviado: number;
  Disparo_respondido: number;
  Taxa_de_resposta: number;
}

export function montarRelatorioPeriodicoBody(kpis: RelatorioPeriodicoKpis): RelatorioPeriodicoBody {
  // Em porcentagem (0 a 100, não 0 a 1) — ex.: 44.74, não 0.4474 — arredondada
  // em 2 casas decimais. Continua sendo um número, não uma string com "%".
  const taxaResposta =
    kpis.disparoEnviado > 0 ? Math.round((kpis.disparoRespondido / kpis.disparoEnviado) * 10000) / 100 : 0;
  return {
    Total_de_ofertas_recebidas: kpis.totalRecebidas,
    Aguardando_processamento: kpis.aguardandoProcessamento,
    Com_Lemit_validado: kpis.limiteValidado,
    Com_Whatsapp_validado: kpis.whatsappValidado,
    Aguardando_consulta_do_disparo: kpis.aguardandoConsultaDisparo,
    Com_disparo_consultado: kpis.disparoConsultado,
    Disparo_enviado: kpis.disparoEnviado,
    Disparo_respondido: kpis.disparoRespondido,
    Taxa_de_resposta: taxaResposta,
  };
}

export async function runRelatorioPeriodicoWorkerOnce(params: RunRelatorioPeriodicoWorkerOnceParams): Promise<number> {
  const { ativo, endpointUrl, kpis, horaInicio, horaFim, agora = new Date(), fetchImpl = fetch } = params;

  if (!ativo) return 0;
  if (!endpointUrl) {
    logger.warn("Relatório periódico ativado mas sem endpoint cadastrado no painel — ciclo ignorado");
    return 0;
  }
  if (!estaDentroDaJanelaDeEnvio(agora, horaInicio, horaFim)) {
    logger.info(
      { horaInicio, horaFim },
      "Fora da janela de horário configurada pro relatório periódico — ciclo ignorado"
    );
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
