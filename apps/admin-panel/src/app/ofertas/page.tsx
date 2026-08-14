import { adminApiFetch } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

interface Offer {
  id: string;
  externalId: string | null;
  cpf: string | null;
  telefoneOriginal: string;
  bancoAutorizado: string | null;
  status: string;
  createdAt: string;
}

interface OffersResponse {
  items: Offer[];
  total: number;
}

export default async function OfertasPage({ searchParams }: { searchParams: { status?: string } }) {
  let data: OffersResponse | null = null;
  let error: string | null = null;
  const status = searchParams.status;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    data = await adminApiFetch<OffersResponse>(`/admin/offers${query}`);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Ofertas</h1>
      <p className="subtitle">
        {data ? `${data.total} oferta(s)` : ""} {status ? `com status ${status}` : ""}
        {status && (
          <>
            {" "}
            — <a href="/ofertas">limpar filtro</a>
          </>
        )}
      </p>

      {error && <p className="empty-state">Não foi possível carregar: {error}</p>}

      <table>
        <thead>
          <tr>
            <th>Recebida em</th>
            <th>ID externo</th>
            <th>Telefone</th>
            <th>Banco</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((offer) => (
            <tr key={offer.id}>
              <td>{new Date(offer.createdAt).toLocaleString("pt-BR")}</td>
              <td>{offer.externalId ?? "—"}</td>
              <td>{offer.telefoneOriginal}</td>
              <td>{offer.bancoAutorizado ?? "—"}</td>
              <td>
                <a href={`/ofertas/${offer.id}`}>
                  <StatusBadge status={offer.status} />
                </a>
              </td>
            </tr>
          ))}
          {data && data.items.length === 0 && (
            <tr>
              <td colSpan={5} className="empty-state">
                Nenhuma oferta encontrada.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
