import { NextRequest, NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

// Proxy server-side pro resumo geral por status (/admin/dashboard) — usado
// pelo detalhamento que aparece quando o usuário seleciona status específicos
// no filtro multi-seleção do Dashboard, e agora também pra alimentar o
// gráfico de rosca (que precisa respeitar o mesmo filtro de status).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";

  try {
    const data = await adminApiFetch(`/admin/dashboard${qs}`);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
