"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { fazerLogin, SESSION_COOKIE } from "@/lib/auth";
import { AdminApiError } from "@/lib/api";

export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") || "").trim();
  const senha = String(formData.get("senha") || "");
  const proximaPagina = String(formData.get("proximaPagina") || "/");

  if (!email || !senha) {
    redirect(`/login?erro=${encodeURIComponent("Preencha e-mail e senha.")}`);
  }

  try {
    const { token } = await fazerLogin(email, senha);
    // httpOnly: o token nunca fica acessível via JS no navegador (protege
    // contra roubo de sessão via XSS). secure: só em produção (HTTPS) — em
    // desenvolvimento local sem HTTPS o cookie ainda precisa funcionar.
    cookies().set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 12 * 60 * 60, // 12 horas — mesmo prazo da sessão no servidor
    });
  } catch (e) {
    const mensagem =
      e instanceof AdminApiError ? e.friendlyMessage ?? "E-mail ou senha incorretos." : "Não foi possível entrar agora. Tente de novo.";
    redirect(`/login?erro=${encodeURIComponent(mensagem)}`);
  }

  redirect(proximaPagina || "/");
}
