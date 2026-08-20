"use client";

// Card de destaque "Comparativo de Disparos" (item 1 do prompt de redesign)
// — duas barras horizontais (Enviados x Respondidos) com o valor absoluto à
// direita. Fica ACIMA da grade de KPIs, junto do card de Taxa de Resposta.
export function ComparativoDisparosCard({ enviados, respondidos }: { enviados: number | null; respondidos: number | null }) {
  const maiorValor = Math.max(1, enviados ?? 0, respondidos ?? 0);

  return (
    <div className="highlight-card">
      <h3>Comparativo de disparos</h3>
      <p className="hc-note">Enviados × Respondidos no período selecionado</p>
      <div className="compare-bars">
        <div className="compare-bar-row">
          <span className="compare-bar-label">Enviados</span>
          <div className="compare-bar-track">
            <div
              className="compare-bar-fill"
              style={{ width: `${Math.max(4, ((enviados ?? 0) / maiorValor) * 100)}%`, background: "var(--series-1)" }}
            />
          </div>
          <span className="compare-bar-value">{(enviados ?? 0).toLocaleString("pt-BR")}</span>
        </div>
        <div className="compare-bar-row">
          <span className="compare-bar-label">Respondidos</span>
          <div className="compare-bar-track">
            <div
              className="compare-bar-fill"
              style={{ width: `${Math.max(4, ((respondidos ?? 0) / maiorValor) * 100)}%`, background: "var(--status-good)" }}
            />
          </div>
          <span className="compare-bar-value">{(respondidos ?? 0).toLocaleString("pt-BR")}</span>
        </div>
      </div>
      <div className="hc-formula">
        Enviados = ofertas com <code>disparo_enviado_em</code> preenchido no período · Respondidos = ofertas com{" "}
        <code>disparo_respondido_em</code> preenchido no período (marcadores cumulativos, nunca sobrescritos).
      </div>
    </div>
  );
}
