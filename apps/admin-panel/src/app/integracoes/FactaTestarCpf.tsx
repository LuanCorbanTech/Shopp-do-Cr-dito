"use client";

import { useState } from "react";

export default function FactaTestarCpf() {
  const [cpf, setCpf] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [resultado, setResultado] = useState<Record<string, unknown> | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function testar() {
    setCarregando(true);
    setErro(null);
    setResultado(null);
    try {
      const resp = await fetch(`/api/facta-margem-testar?cpf=${encodeURIComponent(cpf)}`, { cache: "no-store" });
      const body = await resp.json();
      if (!resp.ok) {
        setErro(body.mensagem ?? "Não foi possível testar.");
        return;
      }
      setResultado(body);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <label htmlFor="facta-cpf-teste" style={{ display: "block", marginBottom: 4 }}>
        Testar com 1 CPF (direto na produção, não afeta nenhuma oferta)
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id="facta-cpf-teste"
          type="text"
          value={cpf}
          onChange={(e) => setCpf(e.target.value)}
          placeholder="Só números, ex.: 12345678900"
          style={{ flex: 1 }}
        />
        <button type="button" onClick={testar} disabled={carregando || !cpf}>
          {carregando ? "Consultando..." : "Testar"}
        </button>
      </div>
      {erro && <p style={{ color: "var(--status-critical)", marginTop: 8 }}>{erro}</p>}
      {resultado && (
        <pre
          style={{
            background: "var(--surface-2, #f5f5f5)",
            padding: 12,
            borderRadius: 6,
            overflowX: "auto",
            fontSize: 12,
            marginTop: 8,
            border: "1px solid var(--border)",
          }}
        >
          {JSON.stringify(resultado, null, 2)}
        </pre>
      )}
    </div>
  );
}
