import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

// Checagem "leve" (só presença do cookie) — roda em toda requisição, então não
// vale a pena validar o token contra o backend aqui (isso acontece uma vez em
// layout.tsx, que já busca o usuário de verdade e redireciona se a sessão
// estiver expirada/inválida). Middleware é só a primeira barreira.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rotas públicas: a própria tela de login e os assets estáticos do Next.
  if (pathname === "/login" || pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("proximaPagina", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/).*)"], // não intercepta as rotas /api/* (proxies internos)
};
