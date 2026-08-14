import { adminApiFetch } from "@/lib/api";
import { createWebhook, toggleWebhook } from "./actions";

export const dynamic = "force-dynamic";

// URL pública que os parceiros chamam pra mandar leads — diferente de
// ADMIN_API_BASE_URL (que é só o painel falando com a API internamente). Configure
// PUBLIC_API_BASE_URL com o domínio HTTPS público da API (ex.:
// https://api.shopdocredtopartner.com.br).
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL ?? "https://SEU-DOMINIO-AQUI";

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
  ofertas_v1: "Timestamp + assinatura (padrão da plataforma)",
  hmac_sha256_simple: "Um único header de assinatura",
};

export default async function ParceirosPage() {
  let webhooks: Webhook[] = [];
  let error: string | null = null;
  try {
    webhooks = await adminApiFetch<Webhook[]>("/admin/webhooks");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Parceiros (recebimento de leads)</h1>
      <p className="subtitle">
        Cada parceiro tem sua própria URL de webhook, secret e esquema de assinatura — um fornecedor
        novo não exige mudar código, só cadastrar aqui (a não ser que o esquema de assinatura dele
        seja um terceiro tipo, ainda não suportado).
      </p>

      {error && <p className="empty-state">Não foi possível carregar: {error}</p>}

      {webhooks.map((wh) => (
        <div key={wh.id} className="card" style={{ marginBottom: 16 }}>
          <div className="toggle-form">
            <strong>{wh.origem}</strong>
            <span className={`badge ${wh.ativo ? "good" : "neutral"}`}>
              {wh.ativo ? "● Ativo" : "○ Inativo"}
            </span>
            <form action={toggleWebhook.bind(null, wh.id, !wh.ativo)}>
              <button type="submit" className="secondary">
                {wh.ativo ? "Desativar" : "Ativar"}
              </button>
            </form>
          </div>

          <table style={{ marginTop: 14 }}>
            <tbody>
              <tr>
                <th style={{ width: 160 }}>URL do webhook</th>
                <td>
                  <code>
                    {PUBLIC_API_BASE_URL}/webhooks/ofertas/{wh.identificador}
                  </code>
                </td>
              </tr>
              <tr>
                <th>Esquema de assinatura</th>
                <td>{ESQUEMA_LABEL[wh.esquemaAssinatura] ?? wh.esquemaAssinatura}</td>
              </tr>
              <tr>
                <th>Header da assinatura</th>
                <td>
                  <code>{wh.headerAssinatura}</code>
                </td>
              </tr>
              {wh.headerTimestamp && (
                <tr>
                  <th>Header do timestamp</th>
                  <td>
                    <code>{wh.headerTimestamp}</code>
                  </td>
                </tr>
              )}
              <tr>
                <th>Secret</th>
                <td>
                  <code>{wh.secretHmac}</code>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}

      {webhooks.length === 0 && !error && <p className="empty-state">Nenhum parceiro cadastrado ainda.</p>}

      <h2>Novo parceiro</h2>
      <form action={createWebhook} className="card" style={{ display: "grid", gap: 10, maxWidth: 480 }}>
        <input name="origem" placeholder="Nome do parceiro (ex.: Odysseia)" required />
        <input
          name="identificador"
          placeholder="Identificador da URL (ex.: odysseia — só letras/números/hífen)"
          pattern="[a-z0-9-]+"
          required
        />
        <select name="esquemaAssinatura" defaultValue="ofertas_v1">
          <option value="ofertas_v1">Timestamp + assinatura (padrão da plataforma)</option>
          <option value="hmac_sha256_simple">Um único header de assinatura (ex.: Odysseia)</option>
        </select>
        <input name="headerAssinatura" placeholder="Header da assinatura (ex.: X-Odysseia-Signature)" />
        <input
          name="headerTimestamp"
          placeholder="Header do timestamp (só se usar o esquema padrão da plataforma)"
        />
        <input
          name="secretHmac"
          placeholder="Secret (deixe em branco pra gerar um automaticamente)"
        />
        <button type="submit">Criar parceiro</button>
      </form>
    </div>
  );
}
