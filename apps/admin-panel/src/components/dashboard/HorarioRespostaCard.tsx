"use client";

import { HorarioRespostaChart } from "../charts/HorarioRespostaChart";

interface PontoHorario {
  hora: number;
  total: number;
}

// Card "Horário com maior taxa de resposta" (cruzamento de dados do redesign
// do Dashboard) — envolve o HorarioRespostaChart com o cabeçalho e a
// explicação, no mesmo padrão dos demais cards de insight desta seção.
export function HorarioRespostaCard({ dados }: { dados: PontoHorario[] }) {
  return (
    <div className="insight-card">
      <h2>🕒 Horário com maior taxa de resposta</h2>
      <p className="chart-sub">
        Volume de <code>disparo_respondido_em</code> agrupado por hora do dia — ajuda a decidir a janela de disparo.
      </p>
      <HorarioRespostaChart dados={dados} />
      <div className="hc-formula">
        Sugestão: concentre reforços/retentativas de disparo na(s) hora(s) em destaque acima — faixa com maior volume histórico de
        resposta nesse período.
      </div>
    </div>
  );
}
