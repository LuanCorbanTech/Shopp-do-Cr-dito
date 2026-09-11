"use client";

interface PontoHistorico {
  consultadoEm: string;
  qualityRating: string;
  messagingLimitTier: string | null;
  status: string | null;
}

const LARGURA = 640;
const ALTURA = 200;
const MARGEM = { top: 16, right: 16, bottom: 28, left: 90 };

// Mesma ordem usada em avaliarPioraQualidade (@plataforma-ofertas/domain) —
// RED embaixo, GREEN em cima, UNKNOWN entre RED e YELLOW.
const NIVEIS: { chave: string; label: string; cor: string }[] = [
  { chave: "RED", label: "Baixa", cor: "var(--status-critical)" },
  { chave: "UNKNOWN", label: "Desconhecida", cor: "var(--neutral-badge-text)" },
  { chave: "YELLOW", label: "Média", cor: "var(--status-warning)" },
  { chave: "GREEN", label: "Alta", cor: "var(--status-good)" },
];

function nivelDe(rating: string): number {
  const i = NIVEIS.findIndex((n) => n.chave === rating);
  return i === -1 ? 1 : i;
}

function formatarDataCurta(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Gráfico simples (SVG puro, sem biblioteca, mesmo espírito do
// TimeSeriesChart do Dashboard) — evolução da qualidade ao longo do tempo,
// em degraus (a qualidade não é um número contínuo, então uma linha reta
// entre pontos venderia uma falsa sensação de "meio termo" que não existe).
export function QualidadeHistoricoChart({ dados }: { dados: PontoHistorico[] }) {
  if (dados.length === 0) {
    return <p className="empty-state">Ainda não há histórico suficiente pra desenhar o gráfico.</p>;
  }

  const largureUtil = LARGURA - MARGEM.left - MARGEM.right;
  const alturaUtil = ALTURA - MARGEM.top - MARGEM.bottom;

  function pontoX(i: number): number {
    return dados.length <= 1 ? MARGEM.left : MARGEM.left + (i / (dados.length - 1)) * largureUtil;
  }
  function pontoY(rating: string): number {
    const nivel = nivelDe(rating);
    return MARGEM.top + alturaUtil - (nivel / (NIVEIS.length - 1)) * alturaUtil;
  }

  const passoRotulo = Math.max(1, Math.ceil(dados.length / 6));

  return (
    <svg viewBox={`0 0 ${LARGURA} ${ALTURA}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Evolução da qualidade ao longo do tempo">
      {NIVEIS.map((nivel, i) => {
        const y = MARGEM.top + alturaUtil - (i / (NIVEIS.length - 1)) * alturaUtil;
        return (
          <g key={nivel.chave}>
            <line x1={MARGEM.left} x2={LARGURA - MARGEM.right} y1={y} y2={y} stroke="var(--gridline)" strokeWidth={1} />
            <text x={MARGEM.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill="var(--text-secondary)">
              {nivel.label}
            </text>
          </g>
        );
      })}

      {/* linha em degraus: de cada ponto, mantém a altura até o próximo */}
      <path
        d={dados
          .map((d, i) => {
            const x = pontoX(i);
            const y = pontoY(d.qualityRating);
            if (i === 0) return `M ${x} ${y}`;
            return `L ${x} ${pontoY(dados[i - 1].qualityRating)} L ${x} ${y}`;
          })
          .join(" ")}
        fill="none"
        stroke="var(--series-1)"
        strokeWidth={2}
      />

      {dados.map((d, i) => (
        <circle key={i} cx={pontoX(i)} cy={pontoY(d.qualityRating)} r={3.5} fill={NIVEIS[nivelDe(d.qualityRating)].cor} />
      ))}

      {dados.map((d, i) =>
        i % passoRotulo === 0 ? (
          <text key={`rotulo-${i}`} x={pontoX(i)} y={ALTURA - 8} textAnchor="middle" fontSize={10} fill="var(--text-secondary)">
            {formatarDataCurta(d.consultadoEm)}
          </text>
        ) : null
      )}
    </svg>
  );
}
