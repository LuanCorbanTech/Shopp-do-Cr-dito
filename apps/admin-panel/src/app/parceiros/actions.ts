"use server";

import { revalidatePath } from "next/cache";
import { adminApiFetch } from "@/lib/api";

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
  revalidatePath("/parceiros");
}

export async function toggleWebhook(id: string, ativo: boolean): Promise<void> {
  await adminApiFetch(`/admin/webhooks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath("/parceiros");
}
