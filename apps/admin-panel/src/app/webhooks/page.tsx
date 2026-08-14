import { adminApiFetch } from "@/lib/api";
import { toggleWebhook } from "./actions";
import { DeleteWebhookButton } from "./DeleteWebhookButton";
import { NovoWebhookForm } from "./NovoWebhookForm";

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
  ofertas_v1: "Padrão da plataforma (timestamp + assinatura)",
  hmac_sha256_simple: "Assinatura simples do parceiro (1 header)",
};

export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: { erro?: string };
}) {
  const erro = searchParams.erro;
  let webhooks: Webhook[] = [];
  let error: string | null = null;
  try {
    webhooks = await adminApiFetch<Webhook[]>("/admin/webhooks");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Webhooks (recebimento de leads de parceiros)</h1>
      <p className="subtitle">
        Cada parceiro que te manda leads precisa de um webhook próprio aqui — isso dá pra ele uma URL
        exclusiva, um segredo pra assinar as requisições e a forma como essa assinatura é conferida.
        Cadastrar um parceiro novo normalmente não exige mexer em código, só criar aqui embaixo.
      </p>

      {erro && (
        <p className="empty-state" style={{ borderColor: "#c0392b", color: "#c0392b" }}>
          {erro}
        </p>
      )}

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
            <DeleteWebhookButton id={wh.id} origem={wh.origem} />
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
                <th>Segredo</th>
                <td>
                  <code>{wh.secretHmac}</code>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}

      {webhooks.length === 0 && !error && <p className="empty-state">Nenhum webhook cadastrado ainda.</p>}

      <h2>Novo webhook</h2>
      <NovoWebhookForm publicApiBaseUrl={PUBLIC_API_BASE_URL} />
    </div>
  );
}
