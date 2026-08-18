"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { encerrarSessao, SESSION_COOKIE } from "@/lib/auth";

export async function logoutAction(): Promise<void> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) {
    await encerrarSessao(token).catch(() => {
      // Mesmo se a chamada ao backend falhar, ainda apagamos o cookie local —
      // o usuário não deve ficar "preso" logado no navegador por causa disso.
    });
  }
  cookies().delete(SESSION_COOKIE);
  redirect("/login");
}
