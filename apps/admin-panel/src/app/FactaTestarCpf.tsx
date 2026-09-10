"use client";

import { useState } from "react";

export default function FactaTestarCpf() {
  const [cpf, setCpf] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [resultado, setResultado] = useState<Record<string, unknown> | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const [cpfOnline, setCpfOnline] = useState("");
  const [nomeOnline, setNomeOnline] = useState("");
  const [celularOnline, setCelularOnline] = useState("");
  const [carregandoOnline, setCarregandoOnline] = useState(false);
  const [resultadoOnline, setResultadoOnline] = useState<Record<string, unknown> | null>(null);
  const [erroOnline, setErroOnline] = useState<string | null>(null);

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

  async function testarOnline() {
    setCarregandoOnline(true);
    setErroOnline(null);
    setResultadoOnline(null);
    try {
      const qs = new URLSearchParams({ cpf: cpfOnline, nome: nomeOnline, celular: celularOnline }).toString();
      const resp = await fetch(`/api/facta-margem-testar-online?${qs}`, { cache: "no-store" });
      const body = await resp.json();
      if (!resp.ok) {
        setErroOnline(body.mensagem ?? "Não foi possível testar.");
        return;
      }
      setResultadoOnline(body);
    } catch (e) {
      setErroOnline(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregandoOnline(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <label htmlFor="facta-cpf-teste" style={{ display: "block", marginBottom: 4 }}>
        Testar consulta OFFLINE com 1 CPF (direto na produção, não afeta nenhuma oferta)
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

      <hr style={{ margin: "20px 0" }} />

      <label style={{ display: "block", marginBottom: 4 }}>
        Testar consulta ONLINE (2ª etapa) — registra autorização de verdade + já tenta consultar
      </label>
      <p className="field-help" style={{ marginTop: 0, marginBottom: 8 }}>
        Diferente da offline, precisa de nome e celular (a Facta exige isso pra registrar a
        autorização). Se a consulta ainda não tiver processado na hora, é só clicar em
        &quot;Testar&quot; de novo em alguns segundos — não precisa registrar a autorização de novo.
      </p>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr 1fr auto" }}>
        <input type="text" value={cpfOnline} onChange={(e) => setCpfOnline(e.target.value)} placeholder="CPF: 12345678900" />
        <input type="text" value={nomeOnline} onChange={(e) => setNomeOnline(e.target.value)} placeholder="Nome completo" />
        <input
          type="text"
          value={celularOnline}
          onChange={(e) => setCelularOnline(e.target.value)}
          placeholder="(51) 99999-9999"
        />
        <button type="button" onClick={testarOnline} disabled={carregandoOnline || !cpfOnline || !nomeOnline || !celularOnline}>
          {carregandoOnline ? "..." : "Testar"}
        </button>
      </div>
      {erroOnline && <p style={{ color: "var(--status-critical)", marginTop: 8 }}>{erroOnline}</p>}
      {resultadoOnline && (
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
          {JSON.stringify(resultadoOnline, null, 2)}
        </pre>
      )}
    </div>
  );
}
