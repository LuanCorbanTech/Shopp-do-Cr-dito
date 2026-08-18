import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./globals.css";
import { AppShell } from "./AppShell";
import { buscarUsuarioPorToken, SESSION_COOKIE } from "@/lib/auth";

export const metadata = {
  title: "Plataforma de Ofertas — Painel",
  description: "Gestão, validação e disparo de ofertas",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  // Não bloqueia a renderização se a chamada falhar (ex.: API fora do ar por
  // um instante) — nesse caso o usuário só aparece como "null" (sem
  // nome/role na sidebar), mas a página continua funcionando; o middleware já
  // cuidou de garantir que existe pelo menos um cookie de sessão presente.
  const usuario = token ? await buscarUsuarioPorToken(token).catch(() => null) : null;

  return (
    <html lang="pt-BR">
      <head>
        {/* Aplica o tema salvo ANTES da página pintar na tela — sem isso, toda
            vez que alguém com tema escuro salvo recarregasse a página, veria um
            "flash" de tela clara por uma fração de segundo antes do React
            hidratar e corrigir. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('admin-theme');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <AppShell usuario={usuario}>{children}</AppShell>
      </body>
    </html>
  );
}
