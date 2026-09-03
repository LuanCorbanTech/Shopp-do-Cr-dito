import { logger } from "@plataforma-ofertas/shared";

// Worker 9 — Tarefas de recebimento (31/08, ampliado em 02/09 com
// pausar/reativar). A cada ciclo, pra cada webhook que tem alguma tarefa
// não-terminal:
//
// 1. Se tem uma tarefa "ocupando" esse webhook (RODANDO, PAUSADA, PAUSANDO
//    ou REATIVANDO), trata ela e NÃO inicia nenhuma pendente enquanto isso
//    (fila — confirmado com o cliente, uma de cada vez por webhook):
//    - PAUSANDO (usuário clicou "Pausar" na tela): desliga o fornecedor de
//      verdade, marca PAUSADA. A contagem de ofertas fica congelada (não
//      soma nada enquanto pausada).
//    - REATIVANDO (usuário clicou "Reativar"): liga o fornecedor de novo,
//      marca RODANDO — continua contando das ofertas recebidas desde o
//      "iniciadoEm" ORIGINAL (não reinicia a contagem do zero).
//    - RODANDO: conta ofertas desde que começou. Bateu a meta? Desliga o
//      fornecedor, marca CONCLUIDA.
//    - PAUSADA: não faz nada esse ciclo — só continua "seguran do a vez".
// 2. Se NÃO tem nenhuma ocupando: pega a pendente mais antiga vencida,
//    liga o fornecedor, marca RODANDO.
//
// Depois que uma tarefa termina, o fornecedor fica desligado até a próxima
// da fila ligar de novo (confirmado com o cliente — não liga sozinho).

export type TarefaStatusOcupante = "RODANDO" | "PAUSADA" | "PAUSANDO" | "REATIVANDO";

export interface TarefaSnapshot {
  id: string;
  nome: string;
  fornecedor: string;
  webhookId: string;
  quantidadeOfertas: number;
  iniciadoEm: Date | null;
  status: TarefaStatusOcupante;
}

export interface TarefaPendenteSnapshot {
  id: string;
  nome: string;
  fornecedor: string;
  webhookId: string;
  quantidadeOfertas: number;
}

export interface TarefaPort {
  /** Ids (distintos) de webhooks que têm ao menos 1 tarefa não-terminal (PENDENTE, RODANDO, PAUSADA, PAUSANDO ou REATIVANDO). */
  listarWebhooksComTarefasAtivas(): Promise<string[]>;
  /** A tarefa que está "ocupando" esse webhook agora (RODANDO, PAUSADA, PAUSANDO ou REATIVANDO) — só pode existir 1 por vez, ou null. */
  buscarTarefaOcupante(webhookId: string): Promise<TarefaSnapshot | null>;
  /** A tarefa PENDENTE mais antiga (por data/hora marcada) desse webhook cuja hora já chegou — ou null. */
  buscarProximaTarefaPendente(webhookId: string, agora: Date): Promise<TarefaPendenteSnapshot | null>;
  /** Quantas ofertas desse webhook foram criadas a partir de (e incluindo) "desde". */
  contarOfertasDesde(webhookId: string, desde: Date): Promise<number>;
  marcarTarefaRodando(id: string, iniciadoEm: Date): Promise<void>;
  marcarTarefaConcluida(id: string, ofertasRecebidas: number, concluidoEm: Date): Promise<void>;
  marcarTarefaErro(id: string, erro: string): Promise<void>;
  marcarTarefaPausada(id: string): Promise<void>;
  /** REATIVANDO -> RODANDO, sem mexer no iniciadoEm (continua contando de onde já estava). */
  marcarTarefaReativada(id: string): Promise<void>;
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
  pausadas: number;
  reativadas: number;
  erros: number;
}

export async function runTarefasWorkerOnce(params: RunTarefasWorkerOnceParams): Promise<RunTarefasWorkerOnceResultado> {
  const { port, ativadores, agora = new Date() } = params;
  let iniciadas = 0;
  let concluidas = 0;
  let pausadas = 0;
  let reativadas = 0;
  let erros = 0;

  const webhookIds = await port.listarWebhooksComTarefasAtivas();

  for (const webhookId of webhookIds) {
    const ocupante = await port.buscarTarefaOcupante(webhookId);

    if (ocupante) {
      if (ocupante.status === "PAUSANDO") {
        const apiKey = await port.buscarApiKeyFornecedor(ocupante.fornecedor);
        const ativar = ativadores[ocupante.fornecedor];
        if (!apiKey || !ativar) {
          await port.marcarTarefaErro(ocupante.id, `Fornecedor "${ocupante.fornecedor}" sem chave de API configurada — não consegui pausar.`);
          erros += 1;
          continue;
        }
        try {
          await ativar({ apiKey, ativo: false });
          await port.marcarTarefaPausada(ocupante.id);
          logger.info({ tarefaId: ocupante.id, webhookId }, "Tarefa pausada — recebimento desligado");
          pausadas += 1;
        } catch (error) {
          const mensagem = error instanceof Error ? error.message : String(error);
          await port.marcarTarefaErro(ocupante.id, mensagem);
          logger.error({ tarefaId: ocupante.id, webhookId, error }, "Falha ao desligar o fornecedor pra pausar a tarefa");
          erros += 1;
        }
        continue;
      }

      if (ocupante.status === "REATIVANDO") {
        const apiKey = await port.buscarApiKeyFornecedor(ocupante.fornecedor);
        const ativar = ativadores[ocupante.fornecedor];
        if (!apiKey || !ativar) {
          await port.marcarTarefaErro(ocupante.id, `Fornecedor "${ocupante.fornecedor}" sem chave de API configurada — não consegui reativar.`);
          erros += 1;
          continue;
        }
        try {
          await ativar({ apiKey, ativo: true });
          await port.marcarTarefaReativada(ocupante.id);
          logger.info({ tarefaId: ocupante.id, webhookId }, "Tarefa reativada — recebimento ligado de novo");
          reativadas += 1;
        } catch (error) {
          const mensagem = error instanceof Error ? error.message : String(error);
          await port.marcarTarefaErro(ocupante.id, mensagem);
          logger.error({ tarefaId: ocupante.id, webhookId, error }, "Falha ao ligar o fornecedor pra reativar a tarefa");
          erros += 1;
        }
        continue;
      }

      if (ocupante.status === "PAUSADA") {
        // Não faz nada esse ciclo — só continua "segurando a vez" na fila.
        continue;
      }

      // status === "RODANDO"
      const total = await port.contarOfertasDesde(webhookId, ocupante.iniciadoEm as Date);
      if (total >= ocupante.quantidadeOfertas) {
        const apiKey = await port.buscarApiKeyFornecedor(ocupante.fornecedor);
        const ativar = ativadores[ocupante.fornecedor];
        if (!apiKey || !ativar) {
          await port.marcarTarefaErro(
            ocupante.id,
            `Fornecedor "${ocupante.fornecedor}" sem chave de API configurada ou não suportado — não consegui desligar o recebimento.`
          );
          erros += 1;
          continue;
        }
        try {
          await ativar({ apiKey, ativo: false });
          await port.marcarTarefaConcluida(ocupante.id, total, agora);
          logger.info({ tarefaId: ocupante.id, webhookId, total }, "Tarefa concluída — recebimento desligado");
          concluidas += 1;
        } catch (error) {
          const mensagem = error instanceof Error ? error.message : String(error);
          await port.marcarTarefaErro(ocupante.id, mensagem);
          logger.error({ tarefaId: ocupante.id, webhookId, error }, "Falha ao desligar o fornecedor pra concluir a tarefa");
          erros += 1;
        }
      }
      continue;
    }

    // Nenhuma ocupante nesse webhook — vê se tem pendente com a hora já vencida.
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

  return { iniciadas, concluidas, pausadas, reativadas, erros };
}
