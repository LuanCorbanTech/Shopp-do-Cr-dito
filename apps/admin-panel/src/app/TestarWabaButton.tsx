"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ResultadoTeste {
  numeros?: { displayPhoneNumber: string; qualityRating: string }[];
  pioraram?: { displayPhoneNumber: string; motivo: string }[];
}

// Consulta essa WABA na Meta AGORA (sem esperar o rodízio do worker) e já
// grava o resultado de verdade — útil logo depois de cadastrar uma WABA
// nova, pra não ficar esperando o ciclo automático só pra ver se o token
// está certo.
export function TestarWabaButton({ wabaContaId }: { wabaContaId: string }) {
  const router = useRouter();
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoTeste | null>(null);

  async function testar() {
    setCarregando(true);
    setErro(null);
    setResultado(null);
    try {
      const resp = await fetch("/api/qualidade-whatsapp-testar-waba", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wabaContaId }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        setErro(body.mensagem ?? "Não foi possível testar.");
        return;
      }
      setResultado(body);
      router.refresh();
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div style={{ display: "inline-block" }}>
      <button type="button" className="secondary" onClick={testar} disabled={carregando} style={{ fontSize: 12, padding: "4px 8px" }}>
        {carregando ? "Consultando..." : "Testar agora"}
      </button>
      {erro && <p style={{ color: "var(--status-critical)", marginTop: 4, fontSize: 12, maxWidth: 320 }}>{erro}</p>}
      {resultado && (
        <p style={{ color: "var(--status-good)", marginTop: 4, fontSize: 12 }}>
          {resultado.numeros?.length ?? 0} número(s) consultado(s)
          {resultado.pioraram && resultado.pioraram.length > 0 ? ` — ${resultado.pioraram.length} piorou/pioraram` : "."}
        </p>
      )}
    </div>
  );
}
