import { NextRequest, NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

// Proxy server-side: o navegador faz polling nessa rota (a cada 30s, ver
// DashboardClient.tsx), e ELA chama a API administrativa de verdade usando o
// ADMIN_API_TOKEN — que nunca sai do servidor Next.js. Sem esse proxy, o
// polling do navegador precisaria do token direto no bundle do cliente, o que
// vazaria o segredo.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const status = searchParams.get("status");

  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (status) query.set("status", status);
  const qs = query.toString();

  try {
    const data = await adminApiFetch(`/admin/dashboard/kpis${qs ? `?${qs}` : ""}`);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
