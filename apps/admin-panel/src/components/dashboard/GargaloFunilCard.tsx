"use client";

interface EtapaFunil {
  label: string;
  value: number;
}

// Card "Gargalo do funil" (cruzamento de dados do redesign do Dashboard) —
// promove a MAIOR queda percentual entre duas etapas consecutivas do funil a
// um alerta visual próprio. Não precisa de endpoint novo: reaproveita os
// mesmos 4 números que já alimentam o Funil de Conversão existente
// (FunnelChart), só muda o cálculo de exibição — em vez de mostrar a
// retenção etapa a etapa lado a lado, destaca automaticamente a pior.
export function GargaloFunilCard({ etapas }: { etapas: EtapaFunil[] }) {
  let piorIndice = -1;
  let piorPerda = -1;
  for (let i = 1; i < etapas.length; i++) {
    const anterior = etapas[i - 1].value;
    if (anterior <= 0) continue;
    const perda = 1 - etapas[i].value / anterior;
    if (perda > piorPerda) {
      piorPerda = perda;
      piorIndice = i;
    }
  }

  const temGargalo = piorIndice > 0 && piorPerda > 0;
  const leadsPerdidos = temGargalo ? etapas[piorIndice - 1].value - etapas[piorIndice].value : 0;

  return (
    <div className="insight-card">
      <h2>🚧 Gargalo do funil</h2>
      <p className="chart-sub">Maior queda percentual entre duas etapas consecutivas do funil, no período.</p>
      <div className="bottleneck-flow">
        {etapas.map((etapa, i) => (
          <span key={etapa.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {i > 0 && <span className="bottleneck-arrow">→</span>}
            <span className={`bottleneck-step${temGargalo && i === piorIndice ? " critico" : ""}`}>{etapa.label}</span>
          </span>
        ))}
      </div>
      {temGargalo ? (
        <div className="bottleneck-loss">
          <b>{Math.round(piorPerda * 100)}%</b> das ofertas de &ldquo;{etapas[piorIndice - 1].label}&rdquo; não avançam para &ldquo;
          {etapas[piorIndice].label}&rdquo; ({leadsPerdidos.toLocaleString("pt-BR")} leads) — a maior perda do funil no período.
        </div>
      ) : (
        <p className="empty-state">Sem dados suficientes para calcular o gargalo nesse período.</p>
      )}
      <div className="hc-formula">
        Cálculo: para cada par de etapas consecutivas, <code>1 − (etapa_atual / etapa_anterior)</code>; destaca automaticamente o maior
        valor.
      </div>
    </div>
  );
}
