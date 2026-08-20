"use client";

import { formatarDuracao } from "./formatacao";

// Card "Tempo médio entre etapas" (cruzamento de dados do redesign do
// Dashboard) — duas médias separadas de propósito: a primeira mede a demora
// do PIPELINE interno (Lemit + validação de WhatsApp em lote); a segunda
// mede a velocidade de resposta do LEAD depois de receber o disparo.
export function TempoMedioEtapasCard({
  recebimentoParaDisparoSegundos,
  disparoParaRespostaSegundos,
}: {
  recebimentoParaDisparoSegundos: number | null;
  disparoParaRespostaSegundos: number | null;
}) {
  return (
    <div className="insight-card">
      <h2>⏱️ Tempo médio entre etapas</h2>
      <p className="chart-sub">Latência do funil — separa &ldquo;demora pra validar&rdquo; de &ldquo;demora pra responder&rdquo;.</p>
      <div className="two-stat">
        <div className="mini-stat">
          <div className="v">{formatarDuracao(recebimentoParaDisparoSegundos)}</div>
          <div className="l">Recebimento → Disparo enviado</div>
        </div>
        <div className="mini-stat">
          <div className="v">{formatarDuracao(disparoParaRespostaSegundos)}</div>
          <div className="l">Disparo enviado → Respondido</div>
        </div>
      </div>
      <div className="hc-formula">
        Médias de <code>disparo_enviado_em − created_at</code> e <code>disparo_respondido_em − disparo_enviado_em</code>, só sobre ofertas
        já concluídas nessa etapa.
      </div>
    </div>
  );
}
