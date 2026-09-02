import { logger } from "@plataforma-ofertas/shared";

// Worker 9 — Tarefas de recebimento (31/08). A cada ciclo:
//
// 1. Pra cada webhook que tem alguma tarefa pendente ou rodando:
//    a. Se já tem uma tarefa RODANDO pra esse webhook: conta quantas ofertas
//       chegaram desde que ela começou. Bateu a meta? Desliga o fornecedor
//       e marca CONCLUIDA. Não bateu? Não faz nada esse ciclo (e — ponto
//       importante, confirmado com o cliente — NÃO inicia nenhuma outra
//       tarefa pendente do MESMO webhook enquanto essa não terminar: elas
//       ficam na fila, na ordem da data/hora marcada).
//    b. Se NÃO tem nenhuma rodando: pega a tarefa pendente mais antiga cuja
//       data/hora já chegou, liga o fornecedor, marca RODANDO.
//
// Depois que uma tarefa termina, o fornecedor fica desligado até a próxima
// da fila ligar de novo (confirmado com o cliente — não liga sozinho).

export interface TarefaSnapshot {
  id: string;
  nome: string;
  fornecedor: string;
  webhookId: string;
  quantidadeOfertas: number;
  iniciadoEm: Date | null;
}

export interface TarefaPort {
  /** Ids (distintos) de webhooks que têm ao menos 1 tarefa PENDENTE ou RODANDO. */
  listarWebhooksComTarefasAtivas(): Promise<string[]>;
  buscarTarefaRodando(webhookId: string): Promise<TarefaSnapshot | null>;
  /** A tarefa PENDENTE mais antiga (por data/hora marcada) desse webhook cuja hora já chegou — ou null. */
  buscarProximaTarefaPendente(webhookId: string, agora: Date): Promise<TarefaSnapshot | null>;
  /** Quantas ofertas desse webhook foram criadas a partir de (e incluindo) "desde". */
  contarOfertasDesde(webhookId: string, desde: Date): Promise<number>;
  marcarTarefaRodando(id: string, iniciadoEm: Date): Promise<void>;
  marcarTarefaConcluida(id: string, ofertasRecebidas: number, concluidoEm: Date): Promise<void>;
  marcarTarefaErro(id: string, erro: string): Promise<void>;
  /** Chave de API configurada pro fornecedor (null se não configurada). */
  buscarApiKeyFornecedor(fornecedor: string): Promise<string | null>;
}

export type AtivarFornecedorFn = (params: { apiKey: string; ativo: boolean }) => Promise<void>;

export interface RunTarefasWorkerOnceParams {
  port: TarefaPort;
  /** Um "ativador" por fornecedor suportado — hoje só "odysseia". */
  ativadores: Record<string, AtivarFornecedorFn>;
  /** Só pra facilitar teste — produção sempre usa o relógio de verdade. */
  agora?: Date;
}

export interface RunTarefasWorkerOnceResultado {
  iniciadas: number;
  concluidas: number;
  erros: number;
}

export async function runTarefasWorkerOnce(params: RunTarefasWorkerOnceParams): Promise<RunTarefasWorkerOnceResultado> {
  const { port, ativadores, agora = new Date() } = params;
  let iniciadas = 0;
  let concluidas = 0;
  let erros = 0;

  const webhookIds = await port.listarWebhooksComTarefasAtivas();

  for (const webhookId of webhookIds) {
    const rodando = await port.buscarTarefaRodando(webhookId);

    if (rodando) {
      // Já tem uma rodando nesse webhook — só checa se bateu a meta.
      // Enquanto não bater, NENHUMA outra tarefa desse webhook é iniciada
      // (fila), mesmo que a hora dela já tenha chegado.
      const total = await port.contarOfertasDesde(webhookId, rodando.iniciadoEm as Date);
      if (total >= rodando.quantidadeOfertas) {
        const apiKey = await port.buscarApiKeyFornecedor(rodando.fornecedor);
        const ativar = ativadores[rodando.fornecedor];
        if (!apiKey || !ativar) {
          await port.marcarTarefaErro(
            rodando.id,
            `Fornecedor "${rodando.fornecedor}" sem chave de API configurada ou não suportado — não consegui desligar o recebimento.`
          );
          erros += 1;
          continue;
        }
        try {
          await ativar({ apiKey, ativo: false });
          await port.marcarTarefaConcluida(rodando.id, total, agora);
          logger.info({ tarefaId: rodando.id, webhookId, total }, "Tarefa concluída — recebimento desligado");
          concluidas += 1;
        } catch (error) {
          const mensagem = error instanceof Error ? error.message : String(error);
          await port.marcarTarefaErro(rodando.id, mensagem);
          logger.error({ tarefaId: rodando.id, webhookId, error }, "Falha ao desligar o fornecedor pra concluir a tarefa");
          erros += 1;
        }
      }
      continue;
    }

    // Nenhuma rodando nesse webhook — vê se tem pendente com a hora já vencida.
    const pendente = await port.buscarProximaTarefaPendente(webhookId, agora);
    if (!pendente) continue;

    const apiKey = await port.buscarApiKeyFornecedor(pendente.fornecedor);
    const ativar = ativadores[pendente.fornecedor];
    if (!apiKey || !ativar) {
      await port.marcarTarefaErro(
        pendente.id,
        `Fornecedor "${pendente.fornecedor}" sem chave de API configurada ou não suportado — não consegui ligar o recebimento.`
      );
      erros += 1;
      continue;
    }
    try {
      await ativar({ apiKey, ativo: true });
      await port.marcarTarefaRodando(pendente.id, agora);
      logger.info({ tarefaId: pendente.id, webhookId }, "Tarefa iniciada — recebimento ligado");
      iniciadas += 1;
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      await port.marcarTarefaErro(pendente.id, mensagem);
      logger.error({ tarefaId: pendente.id, webhookId, error }, "Falha ao ligar o fornecedor pra iniciar a tarefa");
      erros += 1;
    }
  }

  return { iniciadas, concluidas, erros };
}
