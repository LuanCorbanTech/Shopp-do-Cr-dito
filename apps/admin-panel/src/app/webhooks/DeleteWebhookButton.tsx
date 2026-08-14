"use client";

import { deleteWebhook } from "./actions";

// Confirmação nativa do navegador antes de excluir — exclusão é permanente (só
// funciona de verdade se o parceiro nunca recebeu leads; caso contrário a API
// bloqueia e a página volta com uma mensagem de erro, ver actions.ts).
export function DeleteWebhookButton({ id, origem }: { id: string; origem: string }) {
  return (
    <form
      action={deleteWebhook.bind(null, id)}
      onSubmit={(e) => {
        if (!confirm(`Excluir o parceiro "${origem}"? Isso só funciona se ele nunca recebeu nenhum lead.`)) {
          e.preventDefault();
        }
      }}
    >
      <button type="submit" className="secondary danger">
        Excluir
      </button>
    </form>
  );
}
