"use server";

import { revalidatePath } from "next/cache";
import { adminApiFetch } from "@/lib/api";

export async function setLimitEnabled(ativo: boolean): Promise<void> {
  await adminApiFetch("/admin/integrations/limit", {
    method: "POST",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath("/integracoes");
}

// Salva a credencial da Lemit ou da CorbanTech (WhatsApp). Campo de chave vazio
// no formulário = "não trocar a chave atual" (evita apagar a credencial por engano
// ao só atualizar a URL, por exemplo).
export async function salvarCredenciais(integracao: "lemit" | "whatsapp", formData: FormData): Promise<void> {
  const apiKey = String(formData.get("apiKey") ?? "");
  const baseUrl = String(formData.get("baseUrl") ?? "");
  await adminApiFetch("/admin/integrations/credenciais", {
    method: "POST",
    body: JSON.stringify({ integracao, apiKey, baseUrl }),
  });
  revalidatePath("/integracoes");
}
