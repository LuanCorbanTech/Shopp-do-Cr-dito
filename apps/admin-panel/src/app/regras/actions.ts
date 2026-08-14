"use server";

import { revalidatePath } from "next/cache";
import { adminApiFetch } from "@/lib/api";

export async function createRoutingRule(formData: FormData): Promise<void> {
  const condicoes: Record<string, string> = {};
  const banco = formData.get("bancoAutorizado");
  const webhookId = formData.get("webhookId");
  if (banco) condicoes.bancoAutorizado = String(banco);
  if (webhookId) condicoes.webhookId = String(webhookId);

  await adminApiFetch("/admin/routing-rules", {
    method: "POST",
    body: JSON.stringify({
      nome: formData.get("nome"),
      condicoes,
      endpointId: formData.get("endpointId"),
      prioridade: Number(formData.get("prioridade")) || 10,
      ativo: true,
    }),
  });
  revalidatePath("/regras");
}

export async function toggleRoutingRule(id: string, ativo: boolean): Promise<void> {
  await adminApiFetch(`/admin/routing-rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath("/regras");
}
