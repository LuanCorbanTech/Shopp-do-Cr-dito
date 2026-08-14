import { adminApiFetch } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

interface DashboardSummary {
  total: number;
  porStatus: Record<string, number>;
}

const STATUS_ORDER = [
  "RECEBIDO",
  "PROCESSANDO_TELEFONE",
  "TELEFONE_ATUALIZADO",
  "VALIDANDO_WHATSAPP",
  "WHATSAPP_VALIDADO",
  "AGUARDANDO_ROTEAMENTO",
  "AGUARDANDO_ENVIO",
  "EM_PROCESSAMENTO_ENVIO",
  "ENVIADO",
  "SEM_WHATSAPP",
  "SEM_ROTA_CONFIGURADA",
  "ERRO_TELEFONE",
  "ERRO_VALIDACAO_WHATSAPP",
  "ERRO_ENVIO",
  "CANCELADO",
  "EXPIRADO",
];

export default async function DashboardPage() {
  let summary: DashboardSummary | null = null;
  let error: string | null = null;
  try {
    summary = await adminApiFetch<DashboardSummary>("/admin/dashboard");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Dashboard geral</h1>
      <p className="subtitle">Total recebido e distribuição das ofertas por etapa do funil.</p>

      {error && <p className="empty-state">Não foi possível carregar o dashboard: {error}</p>}

      {summary && (
        <>
          <div className="stat-grid">
            <div className="stat-tile">
              <div className="value">{summary.total}</div>
              <div className="label">Total recebido</div>
            </div>
          </div>

          <h2>Por status</h2>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Ofertas</th>
              </tr>
            </thead>
            <tbody>
              {STATUS_ORDER.filter((status) => summary!.porStatus[status]).map((status) => (
                <tr key={status}>
                  <td>
                    <StatusBadge status={status} />
                  </td>
                  <td className="num">{summary!.porStatus[status]}</td>
                </tr>
              ))}
              {Object.keys(summary.porStatus).length === 0 && (
                <tr>
                  <td colSpan={2} className="empty-state">
                    Nenhuma oferta recebida ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
