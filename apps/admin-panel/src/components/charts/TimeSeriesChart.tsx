"use client";

interface PontoSerie {
  dia: string; // "YYYY-MM-DD"
  recebidas: number;
  processadas: number;
}

const LARGURA = 640;
const ALTURA = 220;
const MARGEM = { top: 16, right: 16, bottom: 28, left: 36 };

function formatarDiaCurto(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

// Gráfico de linha simples (SVG puro, sem biblioteca) — volume recebido vs.
// processado por dia, dentro do período filtrado no Dashboard.
export function TimeSeriesChart({ dados }: { dados: PontoSerie[] }) {
  if (dados.length === 0) {
    return <p className="empty-state">Sem dados nesse período.</p>;
  }

  const maxValor = Math.max(1, ...dados.map((d) => Math.max(d.recebidas, d.processadas)));
  const largureUtil = LARGURA - MARGEM.left - MARGEM.right;
  const alturaUtil = ALTURA - MARGEM.top - MARGEM.bottom;

  function pontoX(i: number): number {
    return dados.length <= 1 ? MARGEM.left : MARGEM.left + (i / (dados.length - 1)) * largureUtil;
  }
  function pontoY(valor: number): number {
    return MARGEM.top + alturaUtil - (valor / maxValor) * alturaUtil;
  }

  function caminho(chave: "recebidas" | "processadas"): string {
    return dados.map((d, i) => `${i === 0 ? "M" : "L"} ${pontoX(i)} ${pontoY(d[chave])}`).join(" ");
  }

  // Mostra no máximo ~6 rótulos no eixo X, pra não poluir com períodos longos.
  const passoRotulo = Math.max(1, Math.ceil(dados.length / 6));

  return (
    <svg viewBox={`0 0 ${LARGURA} ${ALTURA}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Volume recebido versus processado por dia">
      {/* linhas guia horizontais */}
      {[0, 0.5, 1].map((f) => (
        <line
          key={f}
          x1={MARGEM.left}
          x2={LARGURA - MARGEM.right}
          y1={MARGEM.top + alturaUtil * (1 - f)}
          y2={MARGEM.top + alturaUtil * (1 - f)}
          stroke="var(--gridline)"
          strokeWidth={1}
        />
      ))}

      <path d={caminho("recebidas")} fill="none" stroke="var(--series-1)" strokeWidth={2} />
      <path d={caminho("processadas")} fill="none" stroke="var(--status-good)" strokeWidth={2} strokeDasharray="5 4" />

      {dados.map((d, i) => (
        <g key={d.dia}>
          <circle cx={pontoX(i)} cy={pontoY(d.recebidas)} r={3} fill="var(--series-1)" />
          <circle cx={pontoX(i)} cy={pontoY(d.processadas)} r={3} fill="var(--status-good)" />
          {i % passoRotulo === 0 && (
            <text x={pontoX(i)} y={ALTURA - 8} fontSize={10} textAnchor="middle" fill="var(--text-muted)">
              {formatarDiaCurto(d.dia)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
