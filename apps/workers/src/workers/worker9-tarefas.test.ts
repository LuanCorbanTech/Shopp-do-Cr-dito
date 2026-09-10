import { describe, expect, it } from "vitest";
import {
  runTarefasWorkerOnce,
  type TarefaPort,
  type TarefaSnapshot,
  type TarefaPendenteSnapshot,
} from "./worker9-tarefas";

function ocupante(overrides: Partial<TarefaSnapshot> = {}): TarefaSnapshot {
  return {
    id: "tarefa-1",
    nome: "Recebimento manhã",
    fornecedor: "odysseia",
    webhookId: "webhook-1",
    quantidadeOfertas: 100,
    iniciadoEm: new Date(),
    status: "RODANDO",
    ...overrides,
  };
}

function pendente(overrides: Partial<TarefaPendenteSnapshot> = {}): TarefaPendenteSnapshot {
  return {
    id: "tarefa-1",
    nome: "Recebimento manhã",
    fornecedor: "odysseia",
    webhookId: "webhook-1",
    quantidadeOfertas: 100,
    ...overrides,
  };
}

// Port fake, em memória — controlável pelos testes, sem precisar de banco.
class FakePort implements TarefaPort {
  webhooksAtivos: string[] = [];
  ocupantePorWebhook = new Map<string, TarefaSnapshot>();
  pendentePorWebhook = new Map<string, TarefaPendenteSnapshot>();
  ofertasPorWebhook = new Map<string, number>();
  apiKeys = new Map<string, string>();

  chamadas: { metodo: string; args: unknown[] }[] = [];

  async listarWebhooksComTarefasAtivas() {
    this.chamadas.push({ metodo: "listar", args: [] });
    return this.webhooksAtivos;
  }
  async buscarTarefaOcupante(webhookId: string) {
    this.chamadas.push({ metodo: "buscarOcupante", args: [webhookId] });
    return this.ocupantePorWebhook.get(webhookId) ?? null;
  }
  async buscarProximaTarefaPendente(webhookId: string, _agora: Date) {
    this.chamadas.push({ metodo: "buscarPendente", args: [webhookId] });
    return this.pendentePorWebhook.get(webhookId) ?? null;
  }
  async contarOfertasDesde(webhookId: string, _desde: Date) {
    this.chamadas.push({ metodo: "contar", args: [webhookId] });
    return this.ofertasPorWebhook.get(webhookId) ?? 0;
  }
  async marcarTarefaRodando(id: string, iniciadoEm: Date) {
    this.chamadas.push({ metodo: "marcarRodando", args: [id, iniciadoEm] });
  }
  async marcarTarefaConcluida(id: string, ofertasRecebidas: number, concluidoEm: Date) {
    this.chamadas.push({ metodo: "marcarConcluida", args: [id, ofertasRecebidas, concluidoEm] });
  }
  async marcarTarefaErro(id: string, erro: string) {
    this.chamadas.push({ metodo: "marcarErro", args: [id, erro] });
  }
  async marcarTarefaPausada(id: string) {
    this.chamadas.push({ metodo: "marcarPausada", args: [id] });
  }
  async marcarTarefaReativada(id: string) {
    this.chamadas.push({ metodo: "marcarReativada", args: [id] });
  }
  async buscarApiKeyFornecedor(fornecedor: string) {
    return this.apiKeys.get(fornecedor) ?? null;
  }
}

describe("runTarefasWorkerOnce", () => {
  it("não faz nada quando não tem nenhum webhook com tarefa ativa", async () => {
    const port = new FakePort();
    const resultado = await runTarefasWorkerOnce({ port, ativadores: {} });
    expect(resultado).toEqual({ iniciadas: 0, concluidas: 0, pausadas: 0, reativadas: 0, erros: 0 });
  });

  it("INICIA uma tarefa pendente vencida: liga o fornecedor e marca RODANDO", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.pendentePorWebhook.set("webhook-1", pendente({ id: "t1" }));
    port.apiKeys.set("odysseia", "ody_chave123");

    let chamouComAtivo: boolean | null = null;
    const resultado = await runTarefasWorkerOnce({
      port,
      ativadores: { odysseia: async ({ ativo }) => { chamouComAtivo = ativo; } },
    });

    expect(resultado.iniciadas).toBe(1);
    expect(chamouComAtivo).toBe(true);
    const marcou = port.chamadas.find((c) => c.metodo === "marcarRodando");
    expect(marcou?.args[0]).toBe("t1");
  });

  it("NÃO inicia uma tarefa pendente se não chegou a hora dela", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.apiKeys.set("odysseia", "ody_chave123");

    let chamouAtivador = false;
    const resultado = await runTarefasWorkerOnce({
      port,
      ativadores: { odysseia: async () => { chamouAtivador = true; } },
    });

    expect(resultado.iniciadas).toBe(0);
    expect(chamouAtivador).toBe(false);
  });

  it("CONCLUI uma tarefa RODANDO quando bate a meta: desliga o fornecedor e marca CONCLUIDA", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", quantidadeOfertas: 50, iniciadoEm: new Date("2026-08-31T10:00:00Z"), status: "RODANDO" }));
    port.ofertasPorWebhook.set("webhook-1", 50);
    port.apiKeys.set("odysseia", "ody_chave123");

    let chamouComAtivo: boolean | null = null;
    const resultado = await runTarefasWorkerOnce({
      port,
      ativadores: { odysseia: async ({ ativo }) => { chamouComAtivo = ativo; } },
    });

    expect(resultado.concluidas).toBe(1);
    expect(chamouComAtivo).toBe(false);
    const marcou = port.chamadas.find((c) => c.metodo === "marcarConcluida");
    expect(marcou?.args).toEqual(["t1", 50, expect.any(Date)]);
  });

  it("NÃO conclui ainda se a contagem está abaixo da meta", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", quantidadeOfertas: 100, status: "RODANDO" }));
    port.ofertasPorWebhook.set("webhook-1", 99);
    port.apiKeys.set("odysseia", "ody_chave123");

    let chamouAtivador = false;
    const resultado = await runTarefasWorkerOnce({
      port,
      ativadores: { odysseia: async () => { chamouAtivador = true; } },
    });

    expect(resultado.concluidas).toBe(0);
    expect(chamouAtivador).toBe(false);
  });

  it("FILA: enquanto tem uma tarefa OCUPANDO esse webhook (RODANDO), NUNCA inicia outra pendente", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1-rodando", quantidadeOfertas: 100, status: "RODANDO" }));
    port.ofertasPorWebhook.set("webhook-1", 30);
    port.pendentePorWebhook.set("webhook-1", pendente({ id: "t2-pendente" }));
    port.apiKeys.set("odysseia", "ody_chave123");

    const resultado = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });

    expect(resultado.iniciadas).toBe(0);
    expect(resultado.concluidas).toBe(0);
    const chamouBuscarPendente = port.chamadas.some((c) => c.metodo === "buscarPendente");
    expect(chamouBuscarPendente).toBe(false);
  });

  it("depois que a tarefa RODANDO conclui, no PRÓXIMO ciclo a pendente da fila é iniciada normalmente", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.apiKeys.set("odysseia", "ody_chave123");

    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1-rodando", quantidadeOfertas: 10, status: "RODANDO" }));
    port.ofertasPorWebhook.set("webhook-1", 10);
    const resultadoCiclo1 = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });
    expect(resultadoCiclo1.concluidas).toBe(1);

    port.ocupantePorWebhook.delete("webhook-1");
    port.pendentePorWebhook.set("webhook-1", pendente({ id: "t2-da-fila" }));

    const resultadoCiclo2 = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });
    expect(resultadoCiclo2.iniciadas).toBe(1);
    const marcouRodando = port.chamadas.find((c) => c.metodo === "marcarRodando");
    expect(marcouRodando?.args[0]).toBe("t2-da-fila");
  });

  it("marca ERRO quando o fornecedor não tem chave de API configurada", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.pendentePorWebhook.set("webhook-1", pendente({ id: "t1" }));

    const resultado = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });

    expect(resultado.erros).toBe(1);
    expect(resultado.iniciadas).toBe(0);
    const marcouErro = port.chamadas.find((c) => c.metodo === "marcarErro");
    expect(marcouErro?.args[0]).toBe("t1");
    expect(String(marcouErro?.args[1])).toContain("sem chave de API");
  });

  it("marca ERRO (sem travar) quando a chamada real pro fornecedor falha", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.pendentePorWebhook.set("webhook-1", pendente({ id: "t1" }));
    port.apiKeys.set("odysseia", "ody_chave123");

    const resultado = await runTarefasWorkerOnce({
      port,
      ativadores: { odysseia: async () => { throw new Error("ECONNREFUSED"); } },
    });

    expect(resultado.erros).toBe(1);
    const marcouErro = port.chamadas.find((c) => c.metodo === "marcarErro");
    expect(marcouErro?.args[1]).toContain("ECONNREFUSED");
  });

  it("processa MÚLTIPLOS webhooks de forma independente no mesmo ciclo", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-A", "webhook-B"];
    port.pendentePorWebhook.set("webhook-A", pendente({ id: "ta", webhookId: "webhook-A" }));
    port.ocupantePorWebhook.set("webhook-B", ocupante({ id: "tb", webhookId: "webhook-B", quantidadeOfertas: 5, status: "RODANDO" }));
    port.ofertasPorWebhook.set("webhook-B", 5);
    port.apiKeys.set("odysseia", "ody_chave123");

    const resultado = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });

    expect(resultado.iniciadas).toBe(1);
    expect(resultado.concluidas).toBe(1);
  });

  // ---- Cenários novos: pausar / reativar ----

  it("PAUSANDO: desliga o fornecedor de verdade e marca PAUSADA", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", status: "PAUSANDO" }));
    port.apiKeys.set("odysseia", "ody_chave123");

    let chamouComAtivo: boolean | null = null;
    const resultado = await runTarefasWorkerOnce({
      port,
      ativadores: { odysseia: async ({ ativo }) => { chamouComAtivo = ativo; } },
    });

    expect(resultado.pausadas).toBe(1);
    expect(chamouComAtivo).toBe(false);
    const marcou = port.chamadas.find((c) => c.metodo === "marcarPausada");
    expect(marcou?.args[0]).toBe("t1");
    // Não deve tentar contar ofertas nem checar meta enquanto pausando.
    expect(port.chamadas.some((c) => c.metodo === "contar")).toBe(false);
  });

  it("REATIVANDO: liga o fornecedor de novo e marca RODANDO (sem mexer na contagem)", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", status: "REATIVANDO" }));
    port.apiKeys.set("odysseia", "ody_chave123");

    let chamouComAtivo: boolean | null = null;
    const resultado = await runTarefasWorkerOnce({
      port,
      ativadores: { odysseia: async ({ ativo }) => { chamouComAtivo = ativo; } },
    });

    expect(resultado.reativadas).toBe(1);
    expect(chamouComAtivo).toBe(true);
    const marcou = port.chamadas.find((c) => c.metodo === "marcarReativada");
    expect(marcou?.args[0]).toBe("t1");
  });

  it("PAUSADA: não faz nada (não conta ofertas, não liga/desliga nada), mas continua ocupando a fila", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", status: "PAUSADA" }));
    port.pendentePorWebhook.set("webhook-1", pendente({ id: "t2-esperando" }));
    port.apiKeys.set("odysseia", "ody_chave123");

    let chamouAtivador = false;
    const resultado = await runTarefasWorkerOnce({
      port,
      ativadores: { odysseia: async () => { chamouAtivador = true; } },
    });

    expect(resultado).toEqual({ iniciadas: 0, concluidas: 0, pausadas: 0, reativadas: 0, erros: 0 });
    expect(chamouAtivador).toBe(false);
    // A pendente NÃO foi iniciada -- a pausada ainda está "segurando a vez".
    expect(port.chamadas.some((c) => c.metodo === "buscarPendente")).toBe(false);
  });

  it("PAUSANDO com erro de chave: marca ERRO, não trava o worker", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", status: "PAUSANDO" }));
    // Sem apiKeys.set -- fornecedor sem chave

    const resultado = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });

    expect(resultado.erros).toBe(1);
    expect(resultado.pausadas).toBe(0);
  });

  it("fluxo completo: RODANDO -> pausa (PAUSANDO->PAUSADA) -> reativa (REATIVANDO->RODANDO) -> conclui", async () => {
    const port = new FakePort();
    port.webhooksAtivos = ["webhook-1"];
    port.apiKeys.set("odysseia", "ody_chave123");
    const iniciadoOriginal = new Date("2026-09-02T10:00:00Z");

    // Ciclo 1: usuário clicou "Pausar" -- status virou PAUSANDO manualmente (simulado)
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", status: "PAUSANDO", iniciadoEm: iniciadoOriginal, quantidadeOfertas: 20 }));
    const r1 = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });
    expect(r1.pausadas).toBe(1);

    // Ciclo 2: confirma que enquanto PAUSADA, nada acontece
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", status: "PAUSADA", iniciadoEm: iniciadoOriginal, quantidadeOfertas: 20 }));
    const r2 = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });
    expect(r2).toEqual({ iniciadas: 0, concluidas: 0, pausadas: 0, reativadas: 0, erros: 0 });

    // Ciclo 3: usuário clicou "Reativar" -- status virou REATIVANDO manualmente (simulado)
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", status: "REATIVANDO", iniciadoEm: iniciadoOriginal, quantidadeOfertas: 20 }));
    const r3 = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });
    expect(r3.reativadas).toBe(1);

    // Ciclo 4: voltou RODANDO, e a contagem CONTINUA usando o iniciadoEm original (não resetou)
    port.ocupantePorWebhook.set("webhook-1", ocupante({ id: "t1", status: "RODANDO", iniciadoEm: iniciadoOriginal, quantidadeOfertas: 20 }));
    port.ofertasPorWebhook.set("webhook-1", 20);
    const r4 = await runTarefasWorkerOnce({ port, ativadores: { odysseia: async () => {} } });
    expect(r4.concluidas).toBe(1);
    const chamadaContar = port.chamadas.find((c) => c.metodo === "contar");
    expect(chamadaContar).toBeTruthy();
  });
});
