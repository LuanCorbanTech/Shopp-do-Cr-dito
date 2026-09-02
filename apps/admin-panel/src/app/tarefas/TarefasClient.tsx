"use client";

import { useEffect, useState } from "react";
import { criarTarefaAction, cancelarTarefaAction } from "./actions";

interface WebhookOpcao {
  id: string;
  identificador: string;
  origem: string;
}

interface Tarefa {
  id: string;
  nome: string;
  fornecedor: string;
  webhookId: string;
  webhook: { id: string; identificador: string; origem: string };
  dataHoraExecucao: string;
  quantidadeOfertas: number;
  status: string;
  ofertasRecebidas: number;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  erro: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  PENDENTE: "Aguardando",
  RODANDO: "Recebendo",
  CONCLUIDA: "Concluída",
  ERRO: "Erro",
  CANCELADA: "Cancelada",
};

const STATUS_CLASSE: Record<string, string> = {
  PENDENTE: "neutral",
  RODANDO: "good",
  CONCLUIDA: "good",
  ERRO: "critical",
  CANCELADA: "neutral",
};

function formatarDataHora(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// Modal de criar tarefa — mesmo padrão visual do modal de detalhes de
// Webhook (overlay escuro, card centralizado, clique fora fecha).
function ModalNovaTarefa({
  webhooks,
  onCriada,
  onFechar,
}: {
  webhooks: WebhookOpcao[];
  onCriada: () => void;
  onFechar: () => void;
}) {
  const [nome, setNome] = useState("");
  const [webhookId, setWebhookId] = useState(webhooks[0]?.id ?? "");
  const [data, setData] = useState("");
  const [hora, setHora] = useState("");
  const [quantidade, setQuantidade] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (!nome.trim() || !webhookId || !data || !hora || !quantidade) {
      setErro("Preencha todos os campos.");
      return;
    }
    const dataHoraExecucao = new Date(`${data}T${hora}:00`);
    if (Number.isNaN(dataHoraExecucao.getTime())) {
      setErro("Data ou horário inválido.");
      return;
    }
    setEnviando(true);
    const resultado = await criarTarefaAction({
      nome: nome.trim(),
      fornecedor: "odysseia",
      webhookId,
      dataHoraExecucao: dataHoraExecucao.toISOString(),
      quantidadeOfertas: Number(quantidade),
    });
    setEnviando(false);
    if (!resultado.ok) {
      setErro(resultado.mensagem ?? "Não foi possível criar a tarefa.");
      return;
    }
    onCriada();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onFechar}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface-1)",
          borderRadius: 10,
          padding: 24,
          width: "min(560px, 92vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Criar tarefa</h2>
        </div>
        <p className="subtitle" style={{ marginTop: 4 }}>
          Liga o recebimento na data/horário marcados, e desliga sozinho quando bater a quantidade de ofertas.
        </p>

        <form onSubmit={enviar}>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="tarefa-nome" style={{ display: "block", marginBottom: 4 }}>
              Nome da tarefa
            </label>
            <input
              id="tarefa-nome"
              type="text"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="ex: Recebimento manhã"
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="tarefa-fornecedor" style={{ display: "block", marginBottom: 4 }}>
              Fornecedor
            </label>
            <select id="tarefa-fornecedor" value="odysseia" disabled style={{ width: "100%" }}>
              <option value="odysseia">Odysseia</option>
            </select>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="tarefa-webhook" style={{ display: "block", marginBottom: 4 }}>
              Webhook (de onde contar as ofertas)
            </label>
            <select
              id="tarefa-webhook"
              value={webhookId}
              onChange={(e) => setWebhookId(e.target.value)}
              style={{ width: "100%" }}
            >
              {webhooks.length === 0 && <option value="">Nenhum webhook cadastrado</option>}
              {webhooks.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.origem} ({w.identificador})
                </option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="tarefa-quantidade" style={{ display: "block", marginBottom: 4 }}>
              Quantidade de ofertas
            </label>
            <input
              id="tarefa-quantidade"
              type="number"
              min={1}
              step={1}
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
              placeholder="ex: 500"
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="tarefa-data" style={{ display: "block", marginBottom: 4 }}>
                Data de execução
              </label>
              <input
                id="tarefa-data"
                type="date"
                value={data}
                onChange={(e) => setData(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="tarefa-hora" style={{ display: "block", marginBottom: 4 }}>
                Horário de execução
              </label>
              <input
                id="tarefa-hora"
                type="time"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
          </div>

          {erro && (
            <p className="field-help" style={{ color: "var(--status-critical)", marginBottom: 12 }}>
              {erro}
            </p>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={enviando}>
              {enviando ? "Criando..." : "Criar tarefa"}
            </button>
            <button type="button" className="ghost" onClick={onFechar} disabled={enviando}>
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function TarefasClient({
  webhooks,
  erroWebhooks,
}: {
  webhooks: WebhookOpcao[];
  erroWebhooks: string | null;
}) {
  const [tarefas, setTarefas] = useState<Tarefa[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [modalAberto, setModalAberto] = useState(false);

  async function carregar() {
    try {
      const resp = await fetch("/api/tarefas", { cache: "no-store" });
      const dados = await resp.json();
      setTarefas(Array.isArray(dados) ? dados : []);
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
    // Atualiza sozinho a cada 15s -- as tarefas "Recebendo" mudam de status
    // em segundo plano (worker9), sem o usuário precisar recarregar a
    // página pra ver o progresso.
    const intervalo = setInterval(carregar, 15000);
    return () => clearInterval(intervalo);
  }, []);

  async function cancelar(id: string) {
    if (!confirm("Cancelar essa tarefa? Ela não vai mais ligar o recebimento na hora marcada.")) return;
    const resultado = await cancelarTarefaAction(id);
    if (!resultado.ok) {
      alert(resultado.mensagem ?? "Não foi possível cancelar.");
      return;
    }
    carregar();
  }

  return (
    <div>
      <h1>Tarefas</h1>
      <p className="subtitle">
        Liga o recebimento de um fornecedor numa data/horário marcados, e desliga sozinho quando bate a
        quantidade de ofertas configurada. Se já tiver outra tarefa rodando pro mesmo webhook, a nova espera
        na fila até a anterior terminar. A chave de API do fornecedor fica na aba{" "}
        <a href="/integracoes">Integrações</a>.
      </p>

      {erroWebhooks && <p className="empty-state">Não foi possível carregar os webhooks: {erroWebhooks}</p>}

      <button type="button" onClick={() => setModalAberto(true)} style={{ marginBottom: 20 }}>
        + Criar tarefa
      </button>

      {modalAberto && (
        <ModalNovaTarefa
          webhooks={webhooks}
          onFechar={() => setModalAberto(false)}
          onCriada={() => {
            setModalAberto(false);
            carregar();
          }}
        />
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Webhook</th>
              <th>Data/hora marcada</th>
              <th>Meta</th>
              <th>Recebidas</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {carregando && (
              <tr>
                <td colSpan={7} className="empty-state">
                  Carregando...
                </td>
              </tr>
            )}
            {!carregando && tarefas.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-state">
                  Nenhuma tarefa criada ainda.
                </td>
              </tr>
            )}
            {tarefas.map((t) => (
              <tr key={t.id}>
                <td>{t.nome}</td>
                <td>
                  {t.webhook.origem} ({t.webhook.identificador})
                </td>
                <td>{formatarDataHora(t.dataHoraExecucao)}</td>
                <td>{t.quantidadeOfertas}</td>
                <td>{t.ofertasRecebidas}</td>
                <td>
                  <span className={`badge ${STATUS_CLASSE[t.status] ?? "neutral"}`}>
                    {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  {t.status === "ERRO" && t.erro && (
                    <div className="field-help" style={{ color: "var(--status-critical)", marginTop: 4 }}>
                      {t.erro}
                    </div>
                  )}
                </td>
                <td>
                  {t.status === "PENDENTE" && (
                    <button type="button" className="ghost" onClick={() => cancelar(t.id)}>
                      Cancelar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
