"use client";

interface PontoSerieDisparo {
  dia: string; // "YYYY-MM-DD"
  enviados: number;
  respondidos: number;
}

const LARGURA = 640;
const ALTURA = 220;
const MARGEM = { top: 16, right: 16, bottom: 28, left: 36 };

function formatarDiaCurto(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

// Gráfico de linha comparando Disparo Enviado x Disparo Respondido por dia —
// mesmo padrão visual do TimeSeriesChart (SVG puro, sem biblioteca), mas
// alimentado pelos marcadores cumulativos (disparo_enviado_em /
// disparo_respondido_em), não pelo status atual — ver dashboardEnviadosVsRespondidos.
export function EnviadosRespondidosChart({ dados }: { dados: PontoSerieDisparo[] }) {
  if (dados.length === 0) {
    return <p className="empty-state">Sem dados nesse período.</p>;
  }

  const maxValor = Math.max(1, ...dados.map((d) => Math.max(d.enviados, d.respondidos)));
  const largureUtil = LARGURA - MARGEM.left - MARGEM.right;
  const alturaUtil = ALTURA - MARGEM.top - MARGEM.bottom;

  function pontoX(i: number): number {
    return dados.length <= 1 ? MARGEM.left : MARGEM.left + (i / (dados.length - 1)) * largureUtil;
  }
  function pontoY(valor: number): number {
    return MARGEM.top + alturaUtil - (valor / maxValor) * alturaUtil;
  }

  function caminho(chave: "enviados" | "respondidos"): string {
    return dados.map((d, i) => `${i === 0 ? "M" : "L"} ${pontoX(i)} ${pontoY(d[chave])}`).join(" ");
  }

  const passoRotulo = Math.max(1, Math.ceil(dados.length / 6));

  return (
    <div>
      <svg
        viewBox={`0 0 ${LARGURA} ${ALTURA}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label="Disparos enviados versus respondidos por dia"
      >
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

        <path d={caminho("enviados")} fill="none" stroke="var(--series-1)" strokeWidth={2} />
        <path d={caminho("respondidos")} fill="none" stroke="var(--status-good)" strokeWidth={2} strokeDasharray="5 4" />

        {dados.map((d, i) => (
          <g key={d.dia}>
            <circle cx={pontoX(i)} cy={pontoY(d.enviados)} r={3} fill="var(--series-1)" />
            <circle cx={pontoX(i)} cy={pontoY(d.respondidos)} r={3} fill="var(--status-good)" />
            {i % passoRotulo === 0 && (
              <text x={pontoX(i)} y={ALTURA - 8} fontSize={10} textAnchor="middle" fill="var(--text-muted)">
                {formatarDiaCurto(d.dia)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
        <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "var(--series-1)", marginRight: 6 }} />Enviados</span>
        <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "var(--status-good)", marginRight: 6 }} />Respondidos</span>
      </div>
    </div>
  );
}
