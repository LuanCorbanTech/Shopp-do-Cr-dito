import { adminApiFetch } from "@/lib/api";
import { createEndpoint, toggleEndpoint } from "./actions";

export const dynamic = "force-dynamic";

interface Endpoint {
  id: string;
  nome: string;
  url: string;
  metodoHttp: string;
  authType: string;
  capacidadeHora: number;
  timeoutMs: number;
  maxTentativas: number;
  ativo: boolean;
}

export default async function EndpointsPage() {
  let endpoints: Endpoint[] = [];
  let error: string | null = null;
  try {
    endpoints = await adminApiFetch<Endpoint[]>("/admin/endpoints");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Endpoints de disparo</h1>
      <p className="subtitle">
        Cada endpoint representa um destino técnico com capacidade própria (item 18 do escopo).
      </p>

      {error && <p className="empty-state">Não foi possível carregar: {error}</p>}

      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>URL</th>
            <th>Auth</th>
            <th style={{ textAlign: "right" }}>Capacidade/hora</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((ep) => (
            <tr key={ep.id}>
              <td>{ep.nome}</td>
              <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{ep.url}</td>
              <td>{ep.authType}</td>
              <td className="num">{ep.capacidadeHora}</td>
              <td>
                <span className={`badge ${ep.ativo ? "good" : "neutral"}`}>{ep.ativo ? "● Ativo" : "○ Inativo"}</span>
              </td>
              <td>
                <form action={toggleEndpoint.bind(null, ep.id, !ep.ativo)}>
                  <button type="submit" className="secondary">
                    {ep.ativo ? "Desativar" : "Ativar"}
                  </button>
                </form>
              </td>
            </tr>
          ))}
          {endpoints.length === 0 && !error && (
            <tr>
              <td colSpan={6} className="empty-state">
                Nenhum endpoint cadastrado ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Novo endpoint</h2>
      <form action={createEndpoint} className="card" style={{ display: "grid", gap: 10, maxWidth: 480 }}>
        <input name="nome" placeholder="Nome (ex.: Endpoint C6)" required />
        <input name="url" placeholder="URL de destino" required />
        <select name="metodoHttp" defaultValue="POST">
          <option value="POST">POST</option>
          <option value="GET">GET</option>
          <option value="PUT">PUT</option>
        </select>
        <select name="authType" defaultValue="NONE">
          <option value="NONE">Sem autenticação</option>
          <option value="API_KEY">API Key</option>
          <option value="BEARER_TOKEN">Bearer Token</option>
          <option value="BASIC">Basic Auth</option>
          <option value="HMAC">HMAC</option>
        </select>
        <input name="credenciaisRef" placeholder="Referência da credencial (nome da env var)" />
        <input name="capacidadeHora" type="number" placeholder="Capacidade por hora" defaultValue={100} required />
        <button type="submit">Criar endpoint</button>
      </form>
    </div>
  );
}
