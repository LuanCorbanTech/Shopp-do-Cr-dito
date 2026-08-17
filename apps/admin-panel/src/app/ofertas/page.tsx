import { adminApiFetch } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { OfferModalButton } from "./OfferModal";

export const dynamic = "force-dynamic";

interface Offer {
  id: string;
  externalId: string | null;
  nome: string | null;
  cpf: string | null;
  sexo: string | null;
  nomeMae: string | null;
  dataNascimento: string | null;
  email: string | null;
  telefoneOriginal: string;
  telefoneLemit: string | null;
  telefoneValidado: string | null;
  whatsappLemit: boolean | null;
  possuiWhatsapp: boolean | null;
  endereco: string | null;
  uf: string | null;
  cep: string | null;
  bairro: string | null;
  cidade: string | null;
  numero: string | null;
  logradouro: string | null;
  complemento: string | null;
  bancoAutorizado: string | null;
  produto: string | null;
  valor: number | null;
  parcelas: number | null;
  status: string;
  createdAt: string;
}

interface OffersResponse {
  items: Offer[];
  total: number;
}

// Telefone mostrado na coluna "WhatsApp": o validado de verdade (Worker 2/
// CorbanTech) se existir; senão o que a Lemit indicou; senão nenhum ainda.
function telefoneWhatsapp(offer: Offer): string | null {
  return offer.telefoneValidado ?? offer.telefoneLemit ?? null;
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
            <th>Nome</th>
            <th>CPF</th>
            <th>WhatsApp</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((offer) => {
            const telefone = telefoneWhatsapp(offer);
            return (
              <tr key={offer.id}>
                <td>{offer.nome ?? "—"}</td>
                <td>{offer.cpf ?? "—"}</td>
                <td>
                  {telefone ?? "—"}
                  {offer.possuiWhatsapp === true && (
                    <span className="badge good" style={{ marginLeft: 8 }}>
                      ✓
                    </span>
                  )}
                  {offer.possuiWhatsapp === false && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      sem WhatsApp
                    </span>
                  )}
                </td>
                <td>
                  <a href={`/ofertas/${offer.id}`}>
                    <StatusBadge status={offer.status} />
                  </a>
                </td>
                <td>
                  <OfferModalButton offer={offer} />
                </td>
              </tr>
            );
          })}
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
