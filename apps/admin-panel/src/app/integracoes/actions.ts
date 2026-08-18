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

// Salva a credencial da Lemit ou da CorbanTech (WhatsApp), e o intervalo do
// CRON em segundos. Campos vazios no formulário = "não trocar o que já
// estava" (evita apagar a credencial/intervalo por engano ao só atualizar
// outro campo, por exemplo).
export async function salvarCredenciais(integracao: "lemit" | "whatsapp", formData: FormData): Promise<void> {
  const apiKey = String(formData.get("apiKey") ?? "");
  const baseUrl = String(formData.get("baseUrl") ?? "");
  const intervaloRaw = String(formData.get("intervaloSegundos") ?? "").trim();
  const intervaloSegundos = intervaloRaw !== "" ? Number(intervaloRaw) : undefined;
  await adminApiFetch("/admin/integrations/credenciais", {
    method: "POST",
    body: JSON.stringify({ integracao, apiKey, baseUrl, intervaloSegundos }),
  });
  revalidatePath("/integracoes");
}
