"use client";

import { formatarPercentual } from "./formatacao";

interface ParceiroTaxaResposta {
  webhookId: string;
  identificador: string;
  origem: string;
  recebidas: number;
  enviados: number;
  respondidos: number;
  taxaResposta: number | null;
}

function corPorTaxa(taxa: number | null): string {
  if (taxa === null) return "var(--text-muted)";
  if (taxa >= 0.35) return "var(--status-good)";
  if (taxa >= 0.25) return "var(--status-warning)";
  return "var(--status-critical)";
}

// Card "Performance por parceiro (webhook de origem)" (cruzamento de dados
// do redesign do Dashboard) — mostra as origens com maior volume, cada uma
// com sua própria taxa de resposta. Usa dashboardTaxaRespostaPorWebhook
// (marcadores cumulativos), não dashboardPorWebhook (status atual) — ver
// comentário no repositório sobre por que essa distinção importa aqui.
export function PerformanceParceiroCard({ dados }: { dados: ParceiroTaxaResposta[] }) {
  const top = [...dados].sort((a, b) => b.recebidas - a.recebidas).slice(0, 5);

  return (
    <div className="insight-card">
      <h2>🔗 Performance por parceiro (webhook de origem)</h2>
      <p className="chart-sub">Top {Math.min(5, dados.length)} origens por volume recebido no período.</p>
      {top.length === 0 ? (
        <p className="empty-state">Sem ofertas nesse período.</p>
      ) : (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Origem</th>
              <th style={{ textAlign: "right" }}>Recebidas</th>
              <th>Taxa de resposta</th>
            </tr>
          </thead>
          <tbody>
            {top.map((p) => (
              <tr key={p.webhookId}>
                <td>{p.origem || p.identificador}</td>
                <td className="num">{p.recebidas.toLocaleString("pt-BR")}</td>
                <td>
                  <div className="bar-cell">
                    <div className="track">
                      <div
                        className="fill"
                        style={{ width: `${Math.min(100, (p.taxaResposta ?? 0) * 100)}%`, background: corPorTaxa(p.taxaResposta) }}
                      />
                    </div>
                    <span>{formatarPercentual(p.taxaResposta, 0)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="hc-formula">
        Mesma lógica de taxa de resposta (respondidos/enviados), recortada por parceiro — evidencia origens com leads de melhor/pior
        qualidade.
      </div>
    </div>
  );
}
