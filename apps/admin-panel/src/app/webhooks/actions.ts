"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AdminApiError, adminApiFetch } from "@/lib/api";

export async function createWebhook(formData: FormData): Promise<void> {
  const esquemaAssinatura = String(formData.get("esquemaAssinatura") || "ofertas_v1");
  await adminApiFetch("/admin/webhooks", {
    method: "POST",
    body: JSON.stringify({
      identificador: formData.get("identificador"),
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
  revalidatePath("/webhooks");
}

export async function toggleWebhook(id: string, ativo: boolean): Promise<void> {
  await adminApiFetch(`/admin/webhooks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath("/webhooks");
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
