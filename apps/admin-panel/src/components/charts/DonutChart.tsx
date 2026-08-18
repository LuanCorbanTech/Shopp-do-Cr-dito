"use client";

interface Segmento {
  label: string;
  value: number;
  color: string;
}

const TAMANHO = 160;
const RAIO = 60;
const ESPESSURA = 22;
const CIRCUNFERENCIA = 2 * Math.PI * RAIO;

// Gráfico de rosca simples (SVG puro) — proporção de cada motivo de
// erro/descarte. Sempre mostra a legenda ao lado com o número exato (a cor
// nunca é o único portador de informação).
export function DonutChart({ segmentos }: { segmentos: Segmento[] }) {
  const total = segmentos.reduce((s, seg) => s + seg.value, 0);

  if (total === 0) {
    return <p className="empty-state">Nenhuma oferta parada por erro nesse período.</p>;
  }

  let acumulado = 0;
  const arcos = segmentos
    .filter((seg) => seg.value > 0)
    .map((seg) => {
      const fracao = seg.value / total;
      const comprimento = fracao * CIRCUNFERENCIA;
      const offset = CIRCUNFERENCIA - acumulado;
      acumulado += comprimento;
      return { ...seg, comprimento, offset, fracao };
    });

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
      <svg viewBox={`0 0 ${TAMANHO} ${TAMANHO}`} width={TAMANHO} height={TAMANHO} role="img" aria-label="Distribuição de motivos de erro">
        <g transform={`translate(${TAMANHO / 2}, ${TAMANHO / 2}) rotate(-90)`}>
          <circle r={RAIO} fill="none" stroke="var(--gridline)" strokeWidth={ESPESSURA} />
          {arcos.map((arco) => (
            <circle
              key={arco.label}
              r={RAIO}
              fill="none"
              stroke={arco.color}
              strokeWidth={ESPESSURA}
              strokeDasharray={`${arco.comprimento} ${CIRCUNFERENCIA - arco.comprimento}`}
              strokeDashoffset={arco.offset}
            />
          ))}
        </g>
        <text x={TAMANHO / 2} y={TAMANHO / 2 - 4} textAnchor="middle" fontSize={20} fontWeight={700} fill="var(--text-primary)">
          {total.toLocaleString("pt-BR")}
        </text>
        <text x={TAMANHO / 2} y={TAMANHO / 2 + 14} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
          total
        </text>
      </svg>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
        {segmentos.map((seg) => (
          <div key={seg.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: seg.color, flexShrink: 0 }} aria-hidden="true" />
            <span style={{ color: "var(--text-secondary)" }}>{seg.label}</span>
            <span style={{ fontWeight: 600, marginLeft: "auto" }}>{seg.value.toLocaleString("pt-BR")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
