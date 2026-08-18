"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { SessaoUsuario } from "@/lib/auth";
import { logoutAction } from "./logout-action";

const ROLE_LABEL: Record<SessaoUsuario["role"], string> = {
  ADMINISTRADOR: "Administrador",
  OPERADOR: "Operador",
  VISUALIZADOR: "Visualizador",
};

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}
interface NavGroup {
  titulo: string;
  items: NavItem[];
}

function IconGrid() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function IconList() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}
function IconWebhook() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="12" r="3" />
      <path d="M8.5 7.5 15.5 11M8.5 16.5 15.5 13" />
    </svg>
  );
}
function IconPlug() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v5M15 2v5" /><path d="M7 7h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5z" /><path d="M12 15v7" />
    </svg>
  );
}
function IconServer() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

const NAV_GROUPS: NavGroup[] = [
  { titulo: "Visão geral", items: [{ href: "/", label: "Dashboard", icon: <IconGrid /> }] },
  { titulo: "Operacional", items: [{ href: "/ofertas", label: "Ofertas", icon: <IconList /> }] },
  {
    titulo: "Conexões",
    items: [
      { href: "/webhooks", label: "Webhooks", icon: <IconWebhook /> },
      { href: "/integracoes", label: "Integrações", icon: <IconPlug /> },
      { href: "/endpoints", label: "Endpoints", icon: <IconServer /> },
    ],
  },
  { titulo: "Administração", items: [{ href: "/usuarios", label: "Usuários", icon: <IconUsers /> }] },
];

function tituloDaPagina(pathname: string): string {
  for (const grupo of NAV_GROUPS) {
    for (const item of grupo.items) {
      if (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)) return item.label;
    }
  }
  return "Plataforma de Ofertas";
}

export function AppShell({ children, usuario }: { children: ReactNode; usuario: SessaoUsuario | null }) {
  const [colapsada, setColapsada] = useState(false);
  const [drawerAberto, setDrawerAberto] = useState(false);
  const pathname = usePathname();

  // Lembra a preferência de expandido/recolhido entre sessões.
  useEffect(() => {
    const salvo = window.localStorage.getItem("sidebar-colapsada");
    if (salvo === "1") setColapsada(true);
  }, []);
  useEffect(() => {
    window.localStorage.setItem("sidebar-colapsada", colapsada ? "1" : "0");
  }, [colapsada]);

  // Fecha o drawer mobile automaticamente ao navegar.
  useEffect(() => {
    setDrawerAberto(false);
  }, [pathname]);

  // Página de login não tem sidebar/cabeçalho — é uma tela cheia própria.
  if (pathname === "/login") {
    return <>{children}</>;
  }

  return (
    <div className={`app-shell${colapsada ? " sidebar-colapsada" : ""}${drawerAberto ? " drawer-aberto" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-topo">
          <span className="sidebar-logo" aria-hidden="true">
            PO
          </span>
          <span className="sidebar-marca">Plataforma de Ofertas</span>
        </div>

        <nav className="sidebar-nav">
          {NAV_GROUPS.map((grupo) => {
            // "Administração" (Usuários) só aparece pra quem é ADMINISTRADOR.
            if (grupo.titulo === "Administração" && usuario?.role !== "ADMINISTRADOR") return null;
            return (
              <div className="sidebar-grupo" key={grupo.titulo}>
                <div className="sidebar-grupo-titulo">{grupo.titulo}</div>
                {grupo.items.map((item) => {
                  const ativo = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  return (
                    <a key={item.href} href={item.href} className={`sidebar-link${ativo ? " ativo" : ""}`} title={item.label}>
                      <span className="sidebar-icon">{item.icon}</span>
                      <span className="sidebar-label">{item.label}</span>
                    </a>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {usuario && (
          <div className="sidebar-perfil">
            <div className="sidebar-perfil-info">
              <div className="sidebar-perfil-nome">{usuario.nome}</div>
              <div className="sidebar-perfil-role">{ROLE_LABEL[usuario.role]}</div>
            </div>
            <form action={logoutAction}>
              <button type="submit" className="sidebar-perfil-sair" title="Sair" aria-label="Sair">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" />
                </svg>
              </button>
            </form>
          </div>
        )}

        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setColapsada((v) => !v)}
          aria-label={colapsada ? "Expandir menu" : "Recolher menu"}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {colapsada ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
          </svg>
          <span className="sidebar-label">Recolher</span>
        </button>
      </aside>

      {drawerAberto && <div className="sidebar-backdrop" onClick={() => setDrawerAberto(false)} aria-hidden="true" />}

      <div className="app-content">
        <header className="app-header">
          <button type="button" className="hamburger" onClick={() => setDrawerAberto(true)} aria-label="Abrir menu">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="breadcrumb">{tituloDaPagina(pathname)}</span>
        </header>
        <main className="shell">{children}</main>
      </div>
    </div>
  );
}
