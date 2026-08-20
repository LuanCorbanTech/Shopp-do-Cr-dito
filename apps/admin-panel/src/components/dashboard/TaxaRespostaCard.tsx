"use client";

import { deltaEhPositivo, formatarDeltaPontosPercentuais, formatarPercentual } from "./formatacao";

interface PontoSerieDisparo {
  dia: string;
  enviados: number;
  respondidos: number;
}

const SPARK_LARGURA = 260;
const SPARK_ALTURA = 40;

// Card de destaque "Taxa de Resposta (%)" (item 1 do prompt de redesign) —
// número grande (hero figure) + selo de variação vs. período anterior +
// sparkline da evolução diária da taxa.
export function TaxaRespostaCard({
  enviados,
  respondidos,
  enviadosAnterior,
  respondidosAnterior,
  serieDisparo,
}: {
  enviados: number | null;
  respondidos: number | null;
  enviadosAnterior: number | null;
  respondidosAnterior: number | null;
  serieDisparo: PontoSerieDisparo[];
}) {
  const taxa = enviados && enviados > 0 ? (respondidos ?? 0) / enviados : null;
  const taxaAnterior = enviadosAnterior && enviadosAnterior > 0 ? (respondidosAnterior ?? 0) / enviadosAnterior : null;
  const deltaTexto = formatarDeltaPontosPercentuais(taxa, taxaAnterior);
  const positivo = deltaEhPositivo(taxa, taxaAnterior);

  const pontosTaxaDiaria = serieDisparo.map((d) => (d.enviados > 0 ? d.respondidos / d.enviados : 0));
  const maxTaxa = Math.max(0.01, ...pontosTaxaDiaria);
  const pontosSvg = pontosTaxaDiaria
    .map((v, i) => {
      const x = pontosTaxaDiaria.length <= 1 ? SPARK_LARGURA : (i / (pontosTaxaDiaria.length - 1)) * SPARK_LARGURA;
      const y = SPARK_ALTURA - (v / maxTaxa) * (SPARK_ALTURA - 6) - 3;
      return `${x},${y}`;
    })
    .join(" ");
  const ultimoPonto = pontosSvg.split(" ").at(-1)?.split(",").map(Number);

  return (
    <div className="highlight-card">
      <h3>Taxa de resposta</h3>
      <p className="hc-note">Respondidos ÷ Enviados</p>
      <div className="hero-stat">
        <span className="value">{formatarPercentual(taxa)}</span>
        {deltaTexto && <span className={`delta ${positivo ? "up-good" : "down-bad"}`}>{deltaTexto}</span>}
      </div>
      {pontosTaxaDiaria.length > 1 && (
        <svg className="sparkline-wrap" viewBox={`0 0 ${SPARK_LARGURA} ${SPARK_ALTURA}`} width="100%" height={SPARK_ALTURA} preserveAspectRatio="none">
          <polyline fill="none" stroke="var(--gridline)" strokeWidth={2} points={pontosSvg} />
          {ultimoPonto && <circle cx={ultimoPonto[0]} cy={ultimoPonto[1]} r={4} fill="var(--status-good)" stroke="var(--surface-1)" strokeWidth={2} />}
        </svg>
      )}
      <div className="hc-formula">
        Taxa = <code>disparoRespondido / disparoEnviado</code> (mesmo período). Sparkline mostra a evolução diária da taxa no período
        selecionado.
      </div>
    </div>
  );
}
