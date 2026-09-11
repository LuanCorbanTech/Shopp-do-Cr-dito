import { notFound } from "next/navigation";
import { adminApiFetch } from "@/lib/api";
import { formatarDataHora } from "@/lib/data-hora";
import { QualidadeHistoricoChart } from "./QualidadeHistoricoChart";

export const dynamic = "force-dynamic";

interface NumeroWhatsappListItem {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string;
  messagingLimitTier: string | null;
  status: string | null;
  atualizadoEm: string;
  wabaId: string;
  wabaNome: string | null;
  bmContaId: string;
  bmNome: string;
}

interface PontoHistorico {
  consultadoEm: string;
  qualityRating: string;
  messagingLimitTier: string | null;
  status: string | null;
}

const ROTULO_QUALIDADE: Record<string, { label: string; badge: string }> = {
  GREEN: { label: "Alta", badge: "good" },
  YELLOW: { label: "Média", badge: "warning" },
  RED: { label: "Baixa", badge: "critical" },
  UNKNOWN: { label: "Desconhecida", badge: "neutral" },
};

export default async function NumeroQualidadeWhatsappPage({ params }: { params: { id: string } }) {
  let numero: NumeroWhatsappListItem | null = null;
  try {
    numero = await adminApiFetch<NumeroWhatsappListItem>(`/admin/qualidade-whatsapp/numeros/${params.id}`);
  } catch {
    numero = null;
  }

  if (!numero) notFound();

  let historico: PontoHistorico[] = [];
  let erroHistorico: string | null = null;
  try {
    historico = await adminApiFetch<PontoHistorico[]>(`/admin/qualidade-whatsapp/numeros/${params.id}/historico`);
  } catch (e) {
    erroHistorico = e instanceof Error ? e.message : String(e);
  }

  const infoQualidade = ROTULO_QUALIDADE[numero.qualityRating] ?? { label: numero.qualityRating, badge: "neutral" };

  return (
    <div>
      <p>
        <a href="/qualidade-whatsapp">← Voltar pra Qualidade WhatsApp</a>
      </p>
      <h1>{numero.displayPhoneNumber}</h1>
      <p className="subtitle">
        {numero.verifiedName ? `${numero.verifiedName} — ` : ""}
        {numero.bmNome} / <code>{numero.wabaNome ?? numero.wabaId}</code>
      </p>

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="value">
            <span className={`badge ${infoQualidade.badge}`}>{infoQualidade.label}</span>
          </div>
          <div className="label">Qualidade atual</div>
        </div>
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 18 }}>
            {numero.messagingLimitTier ?? "—"}
          </div>
          <div className="label">Limite de disparo</div>
        </div>
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 18 }}>
            {numero.status ?? "—"}
          </div>
          <div className="label">Status</div>
        </div>
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 14 }}>
            {formatarDataHora(numero.atualizadoEm)}
          </div>
          <div className="label">Atualizado em</div>
        </div>
      </div>

      <h2 style={{ marginTop: 32 }}>Evolução</h2>
      {erroHistorico && <p className="empty-state">Não foi possível carregar o histórico: {erroHistorico}</p>}
      {!erroHistorico && (
        <div className="card">
          <QualidadeHistoricoChart dados={historico} />
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>Consultas registradas</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Consultado em</th>
              <th>Qualidade</th>
              <th>Limite de disparo</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {[...historico]
              .reverse()
              .slice(0, 100)
              .map((ponto, i) => {
                const info = ROTULO_QUALIDADE[ponto.qualityRating] ?? { label: ponto.qualityRating, badge: "neutral" };
                return (
                  <tr key={i}>
                    <td>{formatarDataHora(ponto.consultadoEm)}</td>
                    <td>
                      <span className={`badge ${info.badge}`}>{info.label}</span>
                    </td>
                    <td>{ponto.messagingLimitTier ?? "—"}</td>
                    <td>{ponto.status ?? "—"}</td>
                  </tr>
                );
              })}
            {historico.length === 0 && (
              <tr>
                <td colSpan={4} className="empty-state">
                  Ainda sem consultas registradas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
