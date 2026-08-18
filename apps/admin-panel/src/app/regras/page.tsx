import { adminApiFetch } from "@/lib/api";
import { createRoutingRule, toggleRoutingRule } from "./actions";

export const dynamic = "force-dynamic";

interface Endpoint {
  id: string;
  nome: string;
}

interface RoutingRule {
  id: string;
  nome: string;
  condicoes: Record<string, unknown>;
  prioridade: number;
  ativo: boolean;
  endpoint: Endpoint;
}

export default async function RegrasPage() {
  let rules: RoutingRule[] = [];
  let endpoints: Endpoint[] = [];
  let error: string | null = null;
  try {
    [rules, endpoints] = await Promise.all([
      adminApiFetch<RoutingRule[]>("/admin/routing-rules"),
      adminApiFetch<Endpoint[]>("/admin/endpoints"),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Regras de roteamento</h1>
      <p className="subtitle">
        A regra mais específica (menor número de prioridade) que casar com a oferta vence
        (Regras de Roteamento). Ofertas sem regra compatível ficam em SEM_ROTA_CONFIGURADA e
        voltam ao fluxo automaticamente quando uma regra for cadastrada.
      </p>

      {error && <p className="empty-state">Não foi possível carregar: {error}</p>}

      <table>
        <thead>
          <tr>
            <th>Prioridade</th>
            <th>Nome</th>
            <th>Condições</th>
            <th>Endpoint</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td className="num">{rule.prioridade}</td>
              <td>{rule.nome}</td>
              <td>
                <code style={{ fontSize: 12 }}>{JSON.stringify(rule.condicoes)}</code>
              </td>
              <td>{rule.endpoint?.nome ?? "—"}</td>
              <td>
                <span className={`badge ${rule.ativo ? "good" : "neutral"}`}>
                  {rule.ativo ? "● Ativa" : "○ Inativa"}
                </span>
              </td>
              <td>
                <form action={toggleRoutingRule.bind(null, rule.id, !rule.ativo)}>
                  <button type="submit" className="secondary">
                    {rule.ativo ? "Desativar" : "Ativar"}
                  </button>
                </form>
              </td>
            </tr>
          ))}
          {rules.length === 0 && !error && (
            <tr>
              <td colSpan={6} className="empty-state">
                Nenhuma regra cadastrada ainda — ofertas ficam em SEM_ROTA_CONFIGURADA.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Nova regra</h2>
      <form action={createRoutingRule} className="card" style={{ display: "grid", gap: 10, maxWidth: 480 }}>
        <input name="nome" placeholder="Nome (ex.: Banco C6 - Webhook A)" required />
        <select name="endpointId" required>
          <option value="">Endpoint de destino…</option>
          {endpoints.map((ep) => (
            <option key={ep.id} value={ep.id}>
              {ep.nome}
            </option>
          ))}
        </select>
        <input name="bancoAutorizado" placeholder="Banco autorizado (ex.: C6) — opcional" />
        <input name="webhookId" placeholder="ID do webhook de origem — opcional" />
        <input name="prioridade" type="number" placeholder="Prioridade (menor = mais específica)" defaultValue={10} required />
        <button type="submit">Criar regra</button>
      </form>
    </div>
  );
}
