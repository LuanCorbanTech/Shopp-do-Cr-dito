"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { OfferModalButton, type OfferFullInfo } from "./OfferModal";
import { TODOS_STATUS } from "@/lib/periodo";

interface Offer extends OfferFullInfo {
  createdAt: string;
}

interface OffersResponse {
  items: Offer[];
  total: number;
}

const TAMANHOS_PAGINA = [20, 50, 100];

// Aplica a máscara 000.000.000-00 progressivamente enquanto o usuário digita
// (aceita colar um CPF já formatado ou só os números).
function aplicarMascaraCpf(valor: string): string {
  const digitos = valor.replace(/\D/g, "").slice(0, 11);
  const partes = [digitos.slice(0, 3), digitos.slice(3, 6), digitos.slice(6, 9), digitos.slice(9, 11)];
  let resultado = partes[0];
  if (partes[1]) resultado += `.${partes[1]}`;
  if (partes[2]) resultado += `.${partes[2]}`;
  if (partes[3]) resultado += `-${partes[3]}`;
  return resultado;
}

function telefoneWhatsapp(offer: Offer): string | null {
  return offer.telefoneValidado ?? offer.telefoneLemit ?? null;
}

export function OfertasClient() {
  const [cpfInput, setCpfInput] = useState("");
  const [statusFiltro, setStatusFiltro] = useState("");
  const [pagina, setPagina] = useState(1);
  const [tamanhoPagina, setTamanhoPagina] = useState(20);

  const [data, setData] = useState<OffersResponse | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams();
      if (statusFiltro) qs.set("status", statusFiltro);
      const cpfDigits = cpfInput.replace(/\D/g, "");
      if (cpfDigits) qs.set("cpf", cpfDigits);
      qs.set("limit", String(tamanhoPagina));
      qs.set("offset", String((pagina - 1) * tamanhoPagina));

      const resp = await fetch(`/api/ofertas?${qs.toString()}`, { cache: "no-store" });
      const json: OffersResponse = await resp.json();
      setData(json);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregando(false);
    }
  }, [statusFiltro, cpfInput, pagina, tamanhoPagina]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Volta pra página 1 sempre que um filtro muda (evita ficar numa página
  // vazia depois de filtrar).
  useEffect(() => {
    setPagina(1);
  }, [statusFiltro, cpfInput, tamanhoPagina]);

  function limparFiltros() {
    setCpfInput("");
    setStatusFiltro("");
    setPagina(1);
  }

  const total = data?.total ?? 0;
  const totalPaginas = Math.max(1, Math.ceil(total / tamanhoPagina));

  return (
    <div>
      <h1>Ofertas</h1>
      <p className="subtitle">{carregando ? "Carregando…" : `${total.toLocaleString("pt-BR")} oferta(s) encontrada(s)`}</p>

      <div className="action-bar">
        <input
          type="text"
          placeholder="Buscar por CPF (000.000.000-00)"
          value={cpfInput}
          onChange={(e) => setCpfInput(aplicarMascaraCpf(e.target.value))}
          inputMode="numeric"
        />
        <select value={statusFiltro} onChange={(e) => setStatusFiltro(e.target.value)}>
          <option value="">Todos os status</option>
          {TODOS_STATUS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" onClick={limparFiltros}>
          Limpar filtros
        </button>
      </div>

      {erro && <p className="empty-state">Não foi possível carregar: {erro}</p>}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>CPF</th>
              <th>Banco</th>
              <th>WhatsApp</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {carregando && !data && (
              <tr>
                <td colSpan={6} className="empty-state">
                  Carregando…
                </td>
              </tr>
            )}
            {data?.items.map((offer) => {
              const telefone = telefoneWhatsapp(offer);
              return (
                <tr key={offer.id}>
                  <td>{offer.nome ?? "—"}</td>
                  <td>{offer.cpf ?? "—"}</td>
                  <td>{offer.bancoAutorizado ?? ""}</td>
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
                <td colSpan={6} className="empty-state">
                  Nenhuma oferta encontrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-bar">
        <div>
          Itens por página:{" "}
          <select value={tamanhoPagina} onChange={(e) => setTamanhoPagina(Number(e.target.value))} style={{ marginLeft: 6 }}>
            {TAMANHOS_PAGINA.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="pagination-controls">
          <button type="button" disabled={pagina <= 1} onClick={() => setPagina((p) => Math.max(1, p - 1))}>
            ← Anterior
          </button>
          <span>
            Página {pagina} de {totalPaginas}
          </span>
          <button type="button" disabled={pagina >= totalPaginas} onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}>
            Próxima →
          </button>
        </div>
        <div>{total.toLocaleString("pt-BR")} registro(s) no total</div>
      </div>
    </div>
  );
}
