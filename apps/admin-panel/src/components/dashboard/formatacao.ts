// Helpers de formatação compartilhados pelos cards novos do redesign do
// Dashboard (faixa de destaque + cruzamento de dados).

/** "4h 12min", "38min" ou "12s" — nunca mais de duas unidades, pra não poluir um card pequeno. */
export function formatarDuracao(segundosTotais: number | null): string {
  if (segundosTotais === null || !Number.isFinite(segundosTotais) || segundosTotais < 0) return "—";
  const segundos = Math.round(segundosTotais);
  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  if (horas > 0) return `${horas}h ${minutos}min`;
  if (minutos > 0) return `${minutos}min`;
  return `${segundos}s`;
}

/** "36,0%" — uma casa decimal, formato brasileiro. */
export function formatarPercentual(fracao: number | null, casasDecimais = 1): string {
  if (fracao === null || !Number.isFinite(fracao)) return "—";
  return `${(fracao * 100).toLocaleString("pt-BR", { minimumFractionDigits: casasDecimais, maximumFractionDigits: casasDecimais })}%`;
}

/** Delta em pontos percentuais entre duas taxas (ex.: 36% vs 33,6% = "+2,4 p.p."). */
export function formatarDeltaPontosPercentuais(atual: number | null, anterior: number | null): string | null {
  if (atual === null || anterior === null || !Number.isFinite(atual) || !Number.isFinite(anterior)) return null;
  const deltaPontos = (atual - anterior) * 100;
  const sinal = deltaPontos >= 0 ? "▲" : "▼";
  return `${sinal} ${Math.abs(deltaPontos).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p. vs período anterior`;
}

/** Delta percentual simples entre dois números absolutos (ex.: 7.940 vs 7.576 = "+4,8%"). */
export function formatarDeltaPercentual(atual: number | null, anterior: number | null): string | null {
  if (atual === null || anterior === null || !Number.isFinite(atual) || !Number.isFinite(anterior) || anterior === 0) return null;
  const delta = ((atual - anterior) / anterior) * 100;
  const sinal = delta >= 0 ? "▲" : "▼";
  return `${sinal} ${Math.abs(delta).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% vs período anterior`;
}

export function deltaEhPositivo(atual: number | null, anterior: number | null): boolean {
  if (atual === null || anterior === null) return true;
  return atual >= anterior;
}
