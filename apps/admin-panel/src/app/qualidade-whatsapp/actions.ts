"use server";

import { revalidatePath } from "next/cache";
import { AdminApiError, adminApiFetch } from "@/lib/api";

const PATH = "/qualidade-whatsapp";

export interface ResultadoCriarBm {
  ok: boolean;
  mensagem?: string;
  wabasCriadas?: number;
  wabasComErro?: { wabaId: string; mensagem: string }[];
}

// Aceita uma WABA por linha, no formato "WABA_ID" ou "WABA_ID, Apelido".
// Linhas em branco são ignoradas.
function parseWabaIds(texto: string): { wabaId: string; nome?: string }[] {
  return texto
    .split("\n")
    .map((linha) => linha.trim())
    .filter(Boolean)
    .map((linha) => {
      const [wabaIdBruto, ...resto] = linha.split(",");
      const wabaId = wabaIdBruto.trim();
      const nome = resto.join(",").trim();
      return nome ? { wabaId, nome } : { wabaId };
    })
    .filter((w) => w.wabaId.length > 0);
}

export async function salvarConfigQualidadeWhatsapp(formData: FormData): Promise<void> {
  await adminApiFetch("/admin/qualidade-whatsapp/config", {
    method: "POST",
    body: JSON.stringify({
      ativo: formData.get("ativo") === "on",
      intervaloSegundos: Number(formData.get("intervaloSegundos")) || undefined,
      versaoGraphApi: String(formData.get("versaoGraphApi") || "").trim() || undefined,
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

// Webhook de Relatório de Qualidade WhatsApp (11/09) — config própria,
// separada da consulta automática acima: substitui o antigo alerta "só
// quando piora" por um relatório periódico completo, com todos os IDs
// cadastrados e a qualidade atual de cada um.
export async function salvarConfigRelatorioQualidadeWhatsapp(formData: FormData): Promise<void> {
  await adminApiFetch("/admin/qualidade-whatsapp/relatorio-config", {
    method: "POST",
    body: JSON.stringify({
      ativo: formData.get("ativo") === "on",
      intervaloSegundos: Number(formData.get("intervaloSegundos")) || undefined,
      webhookUrl: String(formData.get("webhookUrl") || "").trim() || undefined,
    }),
  });
  revalidatePath(PATH);
}

export async function alternarRelatorioQualidadeWhatsappAtivo(ativo: boolean): Promise<void> {
  await adminApiFetch("/admin/qualidade-whatsapp/relatorio-config/ativo", {
    method: "POST",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath(PATH);
}

export async function criarBmConta(formData: FormData): Promise<ResultadoCriarBm> {
  const wabas = parseWabaIds(String(formData.get("wabaIds") || ""));
  try {
    const resultado = await adminApiFetch<{ id: string; wabasCriadas: number; wabasComErro: { wabaId: string; mensagem: string }[] }>(
      "/admin/qualidade-whatsapp/bms",
      {
        method: "POST",
        body: JSON.stringify({
          nome: String(formData.get("nome") || ""),
          tokenAcesso: String(formData.get("tokenAcesso") || ""),
          wabas,
        }),
      }
    );
    revalidatePath(PATH);
    return { ok: true, wabasCriadas: resultado.wabasCriadas, wabasComErro: resultado.wabasComErro };
  } catch (e) {
    const mensagem = e instanceof AdminApiError ? e.friendlyMessage ?? e.message : e instanceof Error ? e.message : String(e);
    return { ok: false, mensagem };
  }
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

// Editar o apelido de uma WABA já cadastrada (11/09 — antes só dava pra
// editar nome/token da BM; a WABA só tinha Ativar/Desativar/Excluir). Campo
// em branco LIMPA o apelido (volta a mostrar só o WABA_ID cru) — mesmo
// comportamento opcional do campo "Apelido" no formulário de adicionar.
// Não mexe no WABA_ID em si — é o identificador de verdade usado nas
// consultas à Meta, editar isso é fora do escopo desse pedido.
export async function atualizarWabaConta(id: string, formData: FormData): Promise<void> {
  await adminApiFetch(`/admin/qualidade-whatsapp/wabas/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      nome: String(formData.get("nome") || "").trim(),
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
