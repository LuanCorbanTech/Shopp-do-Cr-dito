import { adminApiFetch } from "@/lib/api";
import { setLimitEnabled } from "./actions";

export const dynamic = "force-dynamic";

interface LimitStatus {
  ativo: boolean;
  processados: number;
  erros: number;
  ultimaExecucao: string | null;
}

export default async function IntegracoesPage() {
  let status: LimitStatus | null = null;
  let error: string | null = null;
  try {
    status = await adminApiFetch<LimitStatus>("/admin/integrations/limit");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Integrações / Validação de telefone</h1>
      <p className="subtitle">
        Controle da consulta à API Limit (itens 5-11 do escopo). Quando desativada, o telefone
        original é usado sem nenhuma chamada externa — as ofertas nunca ficam presas.
      </p>

      {error && <p className="empty-state">Não foi possível carregar: {error}</p>}

      {status && (
        <div className="card">
          <div className="toggle-form">
            <strong>API Limit</strong>
            <span className={`badge ${status.ativo ? "good" : "neutral"}`}>
              {status.ativo ? "● ATIVADO" : "○ DESATIVADO"}
            </span>
            <form action={setLimitEnabled.bind(null, !status.ativo)}>
              <button type="submit" className={status.ativo ? "secondary" : ""}>
                {status.ativo ? "Desativar" : "Ativar"}
              </button>
            </form>
          </div>

          <div className="stat-grid" style={{ marginTop: 20 }}>
            <div className="stat-tile">
              <div className="value">{status.processados}</div>
              <div className="label">Processados</div>
            </div>
            <div className="stat-tile">
              <div className="value">{status.erros}</div>
              <div className="label">Erros</div>
            </div>
            <div className="stat-tile">
              <div className="value" style={{ fontSize: 14 }}>
                {status.ultimaExecucao ? new Date(status.ultimaExecucao).toLocaleString("pt-BR") : "—"}
              </div>
              <div className="label">Última execução</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
