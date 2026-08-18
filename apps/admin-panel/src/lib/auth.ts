// Helpers de autenticação — SEMPRE usados server-side (Server Actions/Route
// Handlers/middleware), nunca no navegador. O cookie "admin_session" guarda
// só o token opaco de sessão (não a senha nem o ADMIN_API_TOKEN).

import { adminApiFetch, AdminApiError } from "./api";

export const SESSION_COOKIE = "admin_session";

export interface SessaoUsuario {
  id: string;
  nome: string;
  email: string;
  role: "ADMINISTRADOR" | "OPERADOR" | "VISUALIZADOR";
  ativo: boolean;
  ultimoAcesso: string | null;
}

export async function fazerLogin(email: string, senha: string): Promise<{ token: string; usuario: SessaoUsuario }> {
  return adminApiFetch<{ token: string; usuario: SessaoUsuario }>("/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, senha }),
  });
}

export async function buscarUsuarioPorToken(token: string): Promise<SessaoUsuario | null> {
  try {
    return await adminApiFetch<SessaoUsuario>(`/admin/auth/me?token=${encodeURIComponent(token)}`);
  } catch (e) {
    if (e instanceof AdminApiError && e.status === 401) return null;
    throw e;
  }
}

export async function encerrarSessao(token: string): Promise<void> {
  await adminApiFetch("/admin/auth/logout", { method: "POST", body: JSON.stringify({ token }) });
}
