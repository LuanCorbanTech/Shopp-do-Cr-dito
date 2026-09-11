"use client";

import { useState, useTransition } from "react";
import { criarBmConta } from "./actions";

interface Resultado {
  wabasCriadas: number;
  wabasComErro: { wabaId: string; mensagem: string }[];
}

// Cadastro de uma BM nova. O token e o nome são obrigatórios; as WABAs dessa
// BM são opcionais aqui — dá pra colar várias de uma vez (uma por linha) ou
// deixar em branco e ir adicionando depois, uma de cada vez, dentro do card
// da BM já cadastrada.
export function NovaBmForm() {
  const [pending, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  function enviar(formData: FormData) {
    setErro(null);
    setResultado(null);
    startTransition(async () => {
      const r = await criarBmConta(formData);
      if (!r.ok) {
        setErro(r.mensagem ?? "Não foi possível cadastrar a BM.");
        return;
      }
      setResultado({ wabasCriadas: r.wabasCriadas ?? 0, wabasComErro: r.wabasComErro ?? [] });
      const form = document.getElementById("form-nova-bm") as HTMLFormElement | null;
      form?.reset();
    });
  }

  return (
    <form id="form-nova-bm" action={enviar} className="card" style={{ display: "grid", gap: 10, maxWidth: 480 }}>
      <div>
        <label className="field-label" htmlFor="nova-bm-nome">
          Nome/apelido da BM
        </label>
        <input id="nova-bm-nome" name="nome" type="text" placeholder="Nome da BM" required />
      </div>
      <div>
        <label className="field-label" htmlFor="nova-bm-token">
          Token de acesso (system user do app criado dentro dessa BM)
        </label>
        <input id="nova-bm-token" name="tokenAcesso" type="password" autoComplete="off" placeholder="Cole o token aqui" required />
      </div>
      <div>
        <label className="field-label" htmlFor="nova-bm-wabas">
          WABAs dessa BM (opcional)
        </label>
        <p className="field-help">
          Uma WABA por linha, no formato <code>WABA_ID</code> ou <code>WABA_ID, Apelido</code>. Pode colar
          quantas quiser aqui, ou deixar em branco e adicionar depois, uma de cada vez, dentro do card da BM.
        </p>
        <textarea id="nova-bm-wabas" name="wabaIds" rows={4} placeholder={"123456789012345\n987654321098765, Loja Centro"} />
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Cadastrando..." : "Adicionar BM"}
      </button>
      {erro && <p style={{ color: "var(--status-critical)", fontSize: 13 }}>{erro}</p>}
      {resultado && (
        <div style={{ fontSize: 13 }}>
          <p style={{ color: "var(--status-good)" }}>
            BM cadastrada{resultado.wabasCriadas > 0 ? ` com ${resultado.wabasCriadas} WABA(s)` : ""}.
          </p>
          {resultado.wabasComErro.length > 0 && (
            <div style={{ color: "var(--status-critical)", marginTop: 4 }}>
              <p>{resultado.wabasComErro.length} WABA(s) não foram cadastradas:</p>
              <ul style={{ margin: "4px 0 0 18px" }}>
                {resultado.wabasComErro.map((w) => (
                  <li key={w.wabaId}>
                    <code>{w.wabaId}</code>: {w.mensagem}
                  </li>
                ))}
              </ul>
              <p className="field-help">Corrija e adicione essas dentro do card da BM, logo acima.</p>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
