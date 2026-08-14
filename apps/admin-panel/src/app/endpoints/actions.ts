"use server";

import { revalidatePath } from "next/cache";
import { adminApiFetch } from "@/lib/api";

export async function createEndpoint(formData: FormData): Promise<void> {
  await adminApiFetch("/admin/endpoints", {
    method: "POST",
    body: JSON.stringify({
      nome: formData.get("nome"),
      url: formData.get("url"),
      metodoHttp: formData.get("metodoHttp") || "POST",
      authType: formData.get("authType") || "NONE",
      credenciaisRef: formData.get("credenciaisRef") || null,
      capacidadeHora: Number(formData.get("capacidadeHora")) || 100,
      ativo: true,
    }),
  });
  revalidatePath("/endpoints");
}

export async function toggleEndpoint(id: string, ativo: boolean): Promise<void> {
  await adminApiFetch(`/admin/endpoints/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath("/endpoints");
}
