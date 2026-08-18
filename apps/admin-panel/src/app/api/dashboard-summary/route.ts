import { NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

// Proxy server-side pro resumo geral por status (/admin/dashboard) — usado
// pelo detalhamento que aparece quando o usuário seleciona status específicos
// no filtro multi-seleção do Dashboard.
export async function GET() {
  try {
    const data = await adminApiFetch("/admin/dashboard");
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
