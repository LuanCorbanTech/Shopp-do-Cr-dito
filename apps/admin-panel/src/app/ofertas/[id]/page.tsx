import { adminApiFetch } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { formatarDataHora } from "@/lib/data-hora";

export const dynamic = "force-dynamic";

interface OfferTimeline {
  offer: {
    id: string;
    externalId: string | null;
    nome: string | null;
    cpf: string | null;
    telefoneOriginal: string | null;
    telefoneAtualizado: string | null;
    telefoneValidado: string | null;
    bancoAutorizado: string | null;
    status: string;
    createdAt: string;
    dadosPessoaLemit: Record<string, unknown> | null;
    webhook: { identificador: string; origem: string };
    endpoint: { nome: string } | null;
    routingRule: { nome: string } | null;
    payloadOriginal: unknown;
  };
  processingEvents: Array<{
    id: string;
    etapa: string;
    resultado: string;
    tentativa: number;
    createdAt: string;
    response: { erro?: string; message?: string } | Record<string, unknown> | null;
  }>;
  dispatches: Array<{ id: string; status: string; httpStatus: number | null; createdAt: string }>;
  disparoIndividualTentativas: Array<{
    id: string;
    endpointUrl: string;
    modelo: string;
    sucesso: boolean;
    httpStatus: number | null;
    timeout: boolean;
    erro: string | null;
    createdAt: string;
    payloadEnviado: unknown;
  }>;
}

export default async function OfertaDetailPage({ params }: { params: { id: string } }) {
  let data: OfferTimeline | null = null;
  let error: string | null = null;
  try {
    data = await adminApiFetch<OfferTimeline>(`/admin/offers/${params.id}`);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    return <p className="empty-state">Não foi possível carregar a oferta: {error}</p>;
  }
  if (!data) return null;

  const { offer, processingEvents, disparoIndividualTentativas } = data;

  return (
    <div>
      <p>
        <a href="/ofertas">← voltar para ofertas</a>
      </p>
      <h1>
        Oferta {offer.externalId ?? offer.id.slice(0, 8)} <StatusBadge status={offer.status} />
      </h1>
      <p className="subtitle">
        Origem: {offer.webhook.origem} ({offer.webhook.identificador})
      </p>

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 15 }}>
            {offer.nome ?? "—"}
          </div>
          <div className="label">Nome</div>
        </div>
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 15 }}>
            {offer.cpf ?? "—"}
          </div>
          <div className="label">CPF</div>
        </div>
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 15 }}>
            {offer.telefoneValidado ?? offer.telefoneAtualizado ?? offer.telefoneOriginal ?? "—"}
          </div>
          <div className="label">Telefone usado</div>
        </div>
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 15 }}>
            {offer.bancoAutorizado ?? "—"}
          </div>
          <div className="label">Banco autorizado</div>
        </div>
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 15 }}>
            {offer.endpoint?.nome ?? "—"}
          </div>
          <div className="label">Endpoint</div>
        </div>
        <div className="stat-tile">
          <div className="value" style={{ fontSize: 15 }}>
            {offer.routingRule?.nome ?? "—"}
          </div>
          <div className="label">Regra aplicada</div>
        </div>
      </div>

      {offer.dadosPessoaLemit && (
        <>
          <h2>Dados devolvidos pela Lemit</h2>
          <pre
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 16,
              overflowX: "auto",
              fontSize: 13,
            }}
          >
            {JSON.stringify(offer.dadosPessoaLemit, null, 2)}
          </pre>
        </>
      )}

      <h2>Timeline</h2>
      <ul className="timeline">
        <li>
          <span className="ts">{formatarDataHora(offer.createdAt, { second: "2-digit" })}</span>
          Oferta recebida
        </li>
        {processingEvents.map((event) => {
          const detalheErro =
            event.resultado === "FALHA" && event.response && typeof event.response === "object"
              ? ((event.response as { erro?: string; message?: string }).erro ??
                (event.response as { erro?: string; message?: string }).message)
              : null;
          return (
            <li key={event.id}>
              <span className="ts">{formatarDataHora(event.createdAt, { second: "2-digit" })}</span>
              {event.etapa} — {event.resultado} (tentativa {event.tentativa})
              {detalheErro && (
                <div style={{ color: "var(--status-critical)", fontSize: 13, marginTop: 4 }}>Motivo: {String(detalheErro)}</div>
              )}
              {event.response && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>
                    Ver resposta bruta
                  </summary>
                  <pre
                    style={{
                      background: "var(--surface-1)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: 12,
                      overflowX: "auto",
                      fontSize: 12,
                      marginTop: 4,
                    }}
                  >
                    {JSON.stringify(event.response, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
        {processingEvents.length === 0 && (
          <li className="empty-state">Nenhum evento de processamento registrado ainda.</li>
        )}
      </ul>

      <h2>Disparo individual</h2>
      <p className="subtitle">
        Cada tentativa de envio pra um endpoint configurado em Integrações (Hyperflow ou Ararahq) — sucesso ou
        falha, incluindo se foi por timeout.
      </p>
      <ul className="timeline">
        {disparoIndividualTentativas.map((t) => (
          <li key={t.id}>
            <span className="ts">{formatarDataHora(t.createdAt, { second: "2-digit" })}</span>
            <span
              style={{
                color: t.sucesso ? "var(--status-good)" : "var(--status-critical)",
                fontWeight: 600,
              }}
            >
              {t.sucesso ? "Enviado" : "Falhou"}
            </span>{" "}
            — {t.endpointUrl} ({t.modelo === "ararahq" ? "Ararahq" : "Hyperflow"})
            {t.httpStatus !== null && <> · HTTP {t.httpStatus}</>}
            {t.timeout && <> · não respondeu a tempo (timeout)</>}
            {t.erro && (
              <div style={{ color: "var(--status-critical)", fontSize: 13, marginTop: 4 }}>Motivo: {t.erro}</div>
            )}
            {t.payloadEnviado != null && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>
                  Ver payload enviado
                </summary>
                <pre
                  style={{
                    background: "var(--surface-2, #f5f5f5)",
                    padding: 12,
                    borderRadius: 6,
                    overflowX: "auto",
                    fontSize: 12,
                    marginTop: 6,
                    border: "1px solid var(--border)",
                  }}
                >
                  {JSON.stringify(t.payloadEnviado, null, 2)}
                </pre>
              </details>
            )}
          </li>
        ))}
        {disparoIndividualTentativas.length === 0 && (
          <li className="empty-state">Nenhuma tentativa de disparo individual registrada ainda pra essa oferta.</li>
        )}
      </ul>

      <h2>Dado bruto recebido do parceiro</h2>
      <p className="subtitle">
        Exatamente o que o webhook do parceiro mandou pra essa oferta, sem nenhum processamento — útil pra
        conferir se algum campo (como telefone) veio com outro nome do que o sistema espera.
      </p>
      <pre
        style={{
          background: "var(--surface-2, #f5f5f5)",
          padding: 16,
          borderRadius: 8,
          overflowX: "auto",
          fontSize: 13,
          border: "1px solid var(--border)",
        }}
      >
        {JSON.stringify(offer.payloadOriginal, null, 2)}
      </pre>
    </div>
  );
}
