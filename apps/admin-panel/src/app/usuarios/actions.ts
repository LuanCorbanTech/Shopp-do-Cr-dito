"use server";

import { revalidatePath } from "next/cache";
import { adminApiFetch, AdminApiError } from "@/lib/api";

export interface UsuarioPainel {
  id: string;
  nome: string;
  email: string;
  role: "ADMINISTRADOR" | "OPERADOR" | "VISUALIZADOR";
  ativo: boolean;
  ultimoAcesso: string | null;
  createdAt: string;
}

export async function criarUsuarioAction(formData: FormData): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await adminApiFetch("/admin/users", {
      method: "POST",
      body: JSON.stringify({
        nome: formData.get("nome"),
        email: formData.get("email"),
        senha: formData.get("senha"),
        role: formData.get("role"),
      }),
    });
    revalidatePath("/usuarios");
    return { ok: true };
  } catch (e) {
    const mensagem = e instanceof AdminApiError ? e.friendlyMessage ?? e.message : "Não foi possível criar o usuário.";
    return { ok: false, mensagem };
  }
}

export async function atualizarUsuarioAction(
  id: string,
  dados: { nome?: string; email?: string; role?: string; ativo?: boolean }
): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await adminApiFetch(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(dados) });
    revalidatePath("/usuarios");
    return { ok: true };
  } catch (e) {
    const mensagem = e instanceof AdminApiError ? e.friendlyMessage ?? e.message : "Não foi possível atualizar o usuário.";
    return { ok: false, mensagem };
  }
}

export async function gerarSenhaAction(id: string): Promise<{ ok: boolean; senhaTemporaria?: string; mensagem?: string }> {
  try {
    const resp = await adminApiFetch<{ senhaTemporaria: string }>(`/admin/users/${id}/gerar-senha`, { method: "POST" });
    return { ok: true, senhaTemporaria: resp.senhaTemporaria };
  } catch (e) {
    const mensagem = e instanceof AdminApiError ? e.friendlyMessage ?? e.message : "Não foi possível gerar uma senha nova.";
    return { ok: false, mensagem };
  }
}
