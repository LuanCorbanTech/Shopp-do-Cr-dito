"use client";

import { useState, useTransition } from "react";
import { excluirBmContaAction } from "./actions";

// Excluir uma BM apaga em cascata (banco) todas as WABAs dela e o
// histórico de números associados — não tem como desfazer, por isso a
// confirmação nativa do navegador antes de chamar a action de verdade.
export function ExcluirBmButton({ id, nome }: { id: string; nome: string }) {
  const [pending, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);

  function excluir() {
    if (!confirm(`Excluir a BM "${nome}"? Isso apaga também todas as WABAs e o histórico de números dela. Não tem como desfazer.`)) {
      return;
    }
    setErro(null);
    startTransition(async () => {
      const resultado = await excluirBmContaAction(id);
      if (!resultado.ok) setErro(resultado.mensagem ?? "Não foi possível excluir.");
    });
  }

  return (
    <>
      <button type="button" className="secondary danger" onClick={excluir} disabled={pending}>
        {pending ? "Excluindo..." : "Excluir BM"}
      </button>
      {erro && <p style={{ color: "var(--status-critical)", marginTop: 4, fontSize: 12 }}>{erro}</p>}
    </>
  );
}
