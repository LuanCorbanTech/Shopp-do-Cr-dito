"use server";

import { revalidatePath } from "next/cache";
import { adminApiFetch } from "@/lib/api";

const PATH = "/qualidade-whatsapp";

export async function salvarConfigQualidadeWhatsapp(formData: FormData): Promise<void> {
  await adminApiFetch("/admin/qualidade-whatsapp/config", {
    method: "POST",
    body: JSON.stringify({
      ativo: formData.get("ativo") === "on",
      intervaloSegundos: Number(formData.get("intervaloSegundos")) || undefined,
      batchSize: Number(formData.get("batchSize")) || undefined,
      versaoGraphApi: String(formData.get("versaoGraphApi") || "").trim() || undefined,
      webhookAlertaUrl: String(formData.get("webhookAlertaUrl") || "").trim() || undefined,
    }),
  });
  revalidatePath(PATH);
}

export async function alternarQualidadeWhatsappAtivo(ativo: boolean): Promise<void> {
  await adminApiFetch("/admin/qualidade-whatsapp/config/ativo", {
    method: "POST",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath(PATH);
}

export async function criarBmConta(formData: FormData): Promise<void> {
  await adminApiFetch("/admin/qualidade-whatsapp/bms", {
    method: "POST",
    body: JSON.stringify({
      nome: String(formData.get("nome") || ""),
      tokenAcesso: String(formData.get("tokenAcesso") || ""),
    }),
  });
  revalidatePath(PATH);
}

export async function atualizarBmConta(id: string, formData: FormData): Promise<void> {
  const tokenAcesso = String(formData.get("tokenAcesso") || "");
  await adminApiFetch(`/admin/qualidade-whatsapp/bms/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      nome: String(formData.get("nome") || "") || undefined,
      tokenAcesso: tokenAcesso || undefined,
    }),
  });
  revalidatePath(PATH);
}

export async function alternarBmContaAtiva(id: string, ativo: boolean): Promise<void> {
  await adminApiFetch(`/admin/qualidade-whatsapp/bms/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath(PATH);
}

export async function excluirBmContaAction(id: string): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await adminApiFetch(`/admin/qualidade-whatsapp/bms/${id}`, { method: "DELETE" });
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : "Não foi possível excluir." };
  }
}

export async function criarWabaConta(bmContaId: string, formData: FormData): Promise<void> {
  await adminApiFetch(`/admin/qualidade-whatsapp/bms/${bmContaId}/wabas`, {
    method: "POST",
    body: JSON.stringify({
      wabaId: String(formData.get("wabaId") || ""),
      nome: String(formData.get("nome") || "") || undefined,
    }),
  });
  revalidatePath(PATH);
}

export async function alternarWabaContaAtiva(id: string, ativo: boolean): Promise<void> {
  await adminApiFetch(`/admin/qualidade-whatsapp/wabas/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath(PATH);
}

export async function excluirWabaContaAction(id: string): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await adminApiFetch(`/admin/qualidade-whatsapp/wabas/${id}`, { method: "DELETE" });
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : "Não foi possível excluir." };
  }
}
