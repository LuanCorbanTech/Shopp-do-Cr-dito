"use client";

interface PontoSerieRecebidasEnviados {
  dia: string; // "YYYY-MM-DD"
  recebidas: number;
  enviados: number;
}

const LARGURA = 640;
const ALTURA = 220;
const MARGEM = { top: 16, right: 16, bottom: 28, left: 36 };

function formatarDiaCurto(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

// Gráfico de linha comparando Ofertas recebidas x Disparos enviados por dia
// (SVG puro, mesmo padrão de TimeSeriesChart/EnviadosRespondidosChart) —
// diferente do gráfico "recebidas x processadas" já existente: aqui o
// recorte é especificamente sobre o gargalo de conversão até o disparo, não
// sobre qualquer saída das etapas iniciais (boa ou ruim).
export function RecebidasVsEnviadosChart({ dados }: { dados: PontoSerieRecebidasEnviados[] }) {
  if (dados.length === 0) {
    return <p className="empty-state">Sem dados nesse período.</p>;
  }

  const maxValor = Math.max(1, ...dados.map((d) => Math.max(d.recebidas, d.enviados)));
  const largureUtil = LARGURA - MARGEM.left - MARGEM.right;
  const alturaUtil = ALTURA - MARGEM.top - MARGEM.bottom;

  function pontoX(i: number): number {
    return dados.length <= 1 ? MARGEM.left : MARGEM.left + (i / (dados.length - 1)) * largureUtil;
  }
  function pontoY(valor: number): number {
    return MARGEM.top + alturaUtil - (valor / maxValor) * alturaUtil;
  }

  function caminho(chave: "recebidas" | "enviados"): string {
    return dados.map((d, i) => `${i === 0 ? "M" : "L"} ${pontoX(i)} ${pontoY(d[chave])}`).join(" ");
  }

  const passoRotulo = Math.max(1, Math.ceil(dados.length / 6));

  return (
    <div>
      <svg
        viewBox={`0 0 ${LARGURA} ${ALTURA}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label="Ofertas recebidas versus disparos enviados por dia"
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

        <path d={caminho("recebidas")} fill="none" stroke="var(--text-muted)" strokeWidth={2} />
        <path d={caminho("enviados")} fill="none" stroke="var(--series-1)" strokeWidth={2} />

        {dados.map((d, i) => (
          <g key={d.dia}>
            <circle cx={pontoX(i)} cy={pontoY(d.recebidas)} r={3} fill="var(--text-muted)" />
            <circle cx={pontoX(i)} cy={pontoY(d.enviados)} r={3} fill="var(--series-1)" />
            {i % passoRotulo === 0 && (
              <text x={pontoX(i)} y={ALTURA - 8} fontSize={10} textAnchor="middle" fill="var(--text-muted)">
                {formatarDiaCurto(d.dia)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
        <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "var(--text-muted)", marginRight: 6 }} />Recebidas</span>
        <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "var(--series-1)", marginRight: 6 }} />Enviados</span>
      </div>
    </div>
  );
}
