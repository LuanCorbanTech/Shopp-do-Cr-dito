import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Plataforma de Ofertas — Painel",
  description: "Gestão, validação, roteamento e disparo de ofertas",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/integracoes", label: "Integrações" },
  { href: "/endpoints", label: "Endpoints" },
  { href: "/regras", label: "Regras de roteamento" },
  { href: "/ofertas", label: "Ofertas" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <nav className="top-nav">
          <span className="brand">Plataforma de Ofertas</span>
          {NAV.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
