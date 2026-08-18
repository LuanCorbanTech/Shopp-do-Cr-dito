"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AdminApiError, adminApiFetch } from "@/lib/api";

export async function createWebhook(formData: FormData): Promise<void> {
  const esquemaAssinatura = String(formData.get("esquemaAssinatura") || "ofertas_v1");
  const identificador = String(formData.get("identificador") || "");
  try {
    await adminApiFetch("/admin/webhooks", {
      method: "POST",
      body: JSON.stringify({
        identificador,
        origem: formData.get("origem"),
        esquemaAssinatura,
        headerAssinatura: formData.get("headerAssinatura") || undefined,
        headerTimestamp: esquemaAssinatura === "ofertas_v1" ? formData.get("headerTimestamp") || undefined : null,
        // Em branco = a API gera um secret aleatório (caso em que SOMOS nós que
        // definimos e passamos pro parceiro). Preenchido = o parceiro já gerou o
        // dele e só estamos cadastrando (caso da Odysseia).
        secretHmac: formData.get("secretHmac") || undefined,
      }),
    });
  } catch (e) {
    if (e instanceof AdminApiError) {
      const mensagem = e.friendlyMessage ?? "Não foi possível criar o webhook. Tente novamente.";
      redirect(`/webhooks?erro=${encodeURIComponent(mensagem)}`);
    }
    throw e;
  }
  revalidatePath("/webhooks");
  // Redireciona (em vez de só revalidar) pra dar uma confirmação visual clara de
  // que o webhook foi criado — sem isso a página não dá nenhum sinal óbvio de
  // sucesso e é fácil clicar "Criar" de novo sem perceber que já funcionou na
  // primeira vez (o que gera erro de identificador duplicado).
  redirect(`/webhooks?criado=${encodeURIComponent(identificador)}`);
}

export async function toggleWebhook(id: string, ativo: boolean): Promise<void> {
  await adminApiFetch(`/admin/webhooks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath("/webhooks");
}

// Variantes que devolvem um resultado em vez de confiar em redirect/revalidatePath
// — usadas pelo WebhooksClient.tsx (modal), que precisa saber na hora se deu
// certo pra atualizar a lista sem recarregar a página inteira.
export async function toggleWebhookAction(id: string, ativo: boolean): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await adminApiFetch(`/admin/webhooks/${id}`, { method: "PATCH", body: JSON.stringify({ ativo }) });
    return { ok: true };
  } catch (e) {
    const mensagem = e instanceof AdminApiError ? e.friendlyMessage ?? e.message : "Não foi possível atualizar.";
    return { ok: false, mensagem };
  }
}

export async function deleteWebhookAction(id: string): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await adminApiFetch(`/admin/webhooks/${id}`, { method: "DELETE" });
    return { ok: true };
  } catch (e) {
    const mensagem =
      e instanceof AdminApiError && e.status === 409
        ? "Esse parceiro já recebeu leads e não pode ser excluído. Use \"Desativar\" em vez disso."
        : "Não foi possível excluir.";
    return { ok: false, mensagem };
  }
}

// Só exclui de fato se o parceiro nunca recebeu nenhum lead (a API bloqueia com
// 409 caso contrário). Quando bloqueado, redireciona de volta pra página com uma
// mensagem de erro em vez de deixar o Next.js quebrar com uma tela de erro genérica.
export async function deleteWebhook(id: string): Promise<void> {
  try {
    await adminApiFetch(`/admin/webhooks/${id}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof AdminApiError && e.status === 409) {
      redirect(`/webhooks?erro=${encodeURIComponent("Esse parceiro já recebeu leads e não pode ser excluído. Use \"Desativar\" em vez disso.")}`);
    }
    throw e;
  }
  revalidatePath("/webhooks");
}
