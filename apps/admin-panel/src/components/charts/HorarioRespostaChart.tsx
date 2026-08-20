"use client";

interface PontoHorario {
  hora: number; // 0-23
  total: number;
}

const LARGURA = 640;
const ALTURA = 140;
const MARGEM = { top: 8, right: 8, bottom: 22, left: 8 };
const GAP = 3;

// Barras por hora do dia (0h-23h) — escala sequencial de um único tom
// (--series-1, mais opaco quanto maior o valor), com a(s) hora(s) de pico
// destacada(s) em --status-good. Cruzamento de dados do redesign do
// Dashboard: ajuda a decidir a janela de maior taxa de resposta pra
// concentrar reforços/retentativas de disparo.
export function HorarioRespostaChart({ dados }: { dados: PontoHorario[] }) {
  const total = dados.reduce((s, d) => s + d.total, 0);
  if (total === 0) {
    return <p className="empty-state">Sem respostas registradas nesse período.</p>;
  }

  const maxValor = Math.max(1, ...dados.map((d) => d.total));
  const picoValor = maxValor;
  const largureUtil = LARGURA - MARGEM.left - MARGEM.right;
  const alturaUtil = ALTURA - MARGEM.top - MARGEM.bottom;
  const larguraBarra = largureUtil / dados.length - GAP;

  function alturaBarra(valor: number): number {
    return maxValor > 0 ? (valor / maxValor) * alturaUtil : 0;
  }

  const horasPico = dados.filter((d) => d.total === picoValor && picoValor > 0).map((d) => d.hora);
  const rotuloPico =
    horasPico.length > 0
      ? `Pico: ${horasPico.map((h) => `${h}h`).join(", ")}`
      : null;

  return (
    <div>
      {rotuloPico && (
        <div style={{ display: "inline-flex", fontSize: 11, fontWeight: 700, background: "var(--neutral-badge-bg)", color: "var(--neutral-badge-text)", padding: "2px 9px", borderRadius: 999, marginBottom: 8 }}>
          {rotuloPico}
        </div>
      )}
      <svg
        viewBox={`0 0 ${LARGURA} ${ALTURA}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label="Volume de respostas por hora do dia"
      >
        {dados.map((d, i) => {
          const h = alturaBarra(d.total);
          const x = MARGEM.left + i * (larguraBarra + GAP);
          const y = MARGEM.top + alturaUtil - h;
          const ehPico = picoValor > 0 && d.total === picoValor;
          // Intensidade sequencial: quanto maior o valor, mais opaca a barra
          // (mesmo tom --series-1, nunca uma cor diferente por hora).
          const opacidade = maxValor > 0 ? 0.25 + 0.75 * (d.total / maxValor) : 0.25;
          return (
            <g key={d.hora}>
              <rect
                x={x}
                y={y}
                width={Math.max(1, larguraBarra)}
                height={Math.max(1, h)}
                rx={2}
                fill={ehPico ? "var(--status-good)" : "var(--series-1)"}
                opacity={ehPico ? 1 : opacidade}
              />
              {d.hora % 3 === 0 && (
                <text x={x + larguraBarra / 2} y={ALTURA - 6} fontSize={9} textAnchor="middle" fill="var(--text-muted)">
                  {d.hora}h
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
