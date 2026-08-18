"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { NovoWebhookForm } from "./NovoWebhookForm";
import { toggleWebhookAction, deleteWebhookAction } from "./actions";

interface Webhook {
  id: string;
  identificador: string;
  origem: string;
  secretHmac: string;
  ativo: boolean;
  esquemaAssinatura: string;
  headerAssinatura: string;
  headerTimestamp: string | null;
}

const ESQUEMA_LABEL: Record<string, string> = {
  ofertas_v1: "Padrão da plataforma (timestamp + assinatura)",
  hmac_sha256_simple: "Assinatura simples do parceiro (1 header)",
};

// Botão pequeno de copiar — mostra "Copiado!" por 1.5s como confirmação visual.
function BotaoCopiar({ valor }: { valor: string }) {
  const [copiado, setCopiado] = useState(false);
  async function copiar() {
    await navigator.clipboard.writeText(valor);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1500);
  }
  return (
    <button type="button" className="secondary" onClick={copiar} style={{ marginLeft: 8 }}>
      {copiado ? "✓ Copiado!" : "Copiar"}
    </button>
  );
}

function CampoComCopiar({ label, valor }: { label: string; valor: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="field-label">{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{valor}</code>
        <BotaoCopiar valor={valor} />
      </div>
    </div>
  );
}

function DetalheWebhookModal({
  webhook,
  publicApiBaseUrl,
  onFechar,
  onAtualizado,
}: {
  webhook: Webhook;
  publicApiBaseUrl: string;
  onFechar: () => void;
  onAtualizado: () => void;
}) {
  const url = `${publicApiBaseUrl}/webhooks/ofertas/${webhook.identificador}`;

  async function alternarAtivo() {
    const resultado = await toggleWebhookAction(webhook.id, !webhook.ativo);
    if (resultado.ok) {
      onAtualizado();
      onFechar();
    } else {
      alert(resultado.mensagem ?? "Não foi possível atualizar.");
    }
  }

  async function excluir() {
    if (!confirm(`Excluir o parceiro "${webhook.origem}"? Isso só funciona se ele nunca recebeu nenhum lead.`)) return;
    const resultado = await deleteWebhookAction(webhook.id);
    if (resultado.ok) {
      onAtualizado();
      onFechar();
    } else {
      alert(resultado.mensagem ?? "Não foi possível excluir.");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onFechar}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--surface-1)", borderRadius: 10, padding: 24, width: "min(560px, 92vw)", maxHeight: "85vh", overflowY: "auto", border: "1px solid var(--border)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{webhook.origem}</h2>
          <span className={`badge ${webhook.ativo ? "good" : "neutral"}`}>{webhook.ativo ? "● Ativo" : "○ Inativo"}</span>
        </div>
        <p className="subtitle">Identificador: {webhook.identificador}</p>

        <CampoComCopiar label="URL do webhook" valor={url} />
        <CampoComCopiar label="Segredo (secret)" valor={webhook.secretHmac} />
        <CampoComCopiar label="Header da assinatura" valor={webhook.headerAssinatura} />
        {webhook.headerTimestamp && <CampoComCopiar label="Header do timestamp" valor={webhook.headerTimestamp} />}

        <div style={{ marginBottom: 20 }}>
          <div className="field-label">Esquema de assinatura</div>
          <div>{ESQUEMA_LABEL[webhook.esquemaAssinatura] ?? webhook.esquemaAssinatura}</div>
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
          <button type="button" className="secondary danger" onClick={excluir}>
            Excluir
          </button>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="secondary" onClick={alternarAtivo}>
              {webhook.ativo ? "Desativar" : "Ativar"}
            </button>
            <button type="button" className="secondary" onClick={onFechar}>
              Fechar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NovoWebhookModal({ publicApiBaseUrl, onFechar }: { publicApiBaseUrl: string; onFechar: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onFechar}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 100%)", maxHeight: "85vh", overflowY: "auto" }}>
        <NovoWebhookForm publicApiBaseUrl={publicApiBaseUrl} />
      </div>
    </div>
  );
}

export function WebhooksClient({ publicApiBaseUrl }: { publicApiBaseUrl: string }) {
  const searchParams = useSearchParams();
  const erro = searchParams.get("erro");
  const criado = searchParams.get("criado");

  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalNovo, setModalNovo] = useState(false);
  const [detalhe, setDetalhe] = useState<Webhook | null>(null);

  async function carregar() {
    setCarregando(true);
    try {
      const resp = await fetch("/api/webhooks", { cache: "no-store" });
      const json = await resp.json();
      setWebhooks(Array.isArray(json) ? json : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  return (
    <div>
      <div className="dash-header">
        <div>
          <h1>Webhooks (recebimento de leads de parceiros)</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Cada parceiro que te manda leads precisa de um webhook próprio — URL exclusiva, segredo pra
            assinar as requisições, e como essa assinatura é conferida.
          </p>
        </div>
        <button type="button" onClick={() => setModalNovo(true)}>
          + Criar novo webhook
        </button>
      </div>

      {criado && (
        <p className="empty-state" style={{ borderColor: "var(--status-good)", color: "var(--status-good)" }}>
          ✓ Webhook &quot;{criado}&quot; criado com sucesso! Já aparece na lista abaixo.
        </p>
      )}
      {erro && (
        <p className="empty-state" style={{ borderColor: "var(--status-critical)", color: "var(--status-critical)" }}>
          {erro}
        </p>
      )}
      {error && <p className="empty-state">Não foi possível carregar: {error}</p>}

      <div className="kpi-grid">
        {carregando && <p className="empty-state">Carregando…</p>}
        {!carregando &&
          webhooks.map((wh) => (
            <div key={wh.id} className="chart-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <strong>{wh.origem}</strong>
                <span className={`badge ${wh.ativo ? "good" : "neutral"}`}>{wh.ativo ? "● Ativo" : "○ Inativo"}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{wh.identificador}</div>
              <button type="button" className="secondary" onClick={() => setDetalhe(wh)} style={{ marginTop: "auto" }}>
                👁 Ver detalhes
              </button>
            </div>
          ))}
        {!carregando && webhooks.length === 0 && !error && <p className="empty-state">Nenhum webhook cadastrado ainda.</p>}
      </div>

      {modalNovo && <NovoWebhookModal publicApiBaseUrl={publicApiBaseUrl} onFechar={() => setModalNovo(false)} />}
      {detalhe && (
        <DetalheWebhookModal webhook={detalhe} publicApiBaseUrl={publicApiBaseUrl} onFechar={() => setDetalhe(null)} onAtualizado={carregar} />
      )}
    </div>
  );
}
