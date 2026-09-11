"use client";

import { useState, useTransition } from "react";
import { excluirWabaContaAction } from "./actions";

export function ExcluirWabaButton({ id, wabaId }: { id: string; wabaId: string }) {
  const [pending, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);

  function excluir() {
    if (!confirm(`Excluir a WABA "${wabaId}"? Isso apaga também o histórico de números dela. Não tem como desfazer.`)) {
      return;
    }
    setErro(null);
    startTransition(async () => {
      const resultado = await excluirWabaContaAction(id);
      if (!resultado.ok) setErro(resultado.mensagem ?? "Não foi possível excluir.");
    });
  }

  return (
    <>
      <button type="button" className="secondary danger" onClick={excluir} disabled={pending} style={{ fontSize: 12, padding: "4px 8px" }}>
        {pending ? "..." : "Excluir"}
      </button>
      {erro && <p style={{ color: "var(--status-critical)", marginTop: 4, fontSize: 12 }}>{erro}</p>}
    </>
  );
}
