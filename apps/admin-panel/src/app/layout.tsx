import type { ReactNode } from "react";
import "./globals.css";
import { AppShell } from "./AppShell";

export const metadata = {
  title: "Plataforma de Ofertas — Painel",
  description: "Gestão, validação e disparo de ofertas",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
