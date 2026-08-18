import { NextRequest, NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

// Mesmo motivo do dashboard-kpis/route.ts: proxy server-side pra manter o
// ADMIN_API_TOKEN fora do navegador, já que essa tela agora atualiza a lista
// (busca por CPF, troca de página) via chamadas do lado do cliente.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const cpf = searchParams.get("cpf");
  const limit = searchParams.get("limit");
  const offset = searchParams.get("offset");

  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (cpf) query.set("cpf", cpf);
  if (limit) query.set("limit", limit);
  if (offset) query.set("offset", offset);
  const qs = query.toString();

  try {
    const data = await adminApiFetch(`/admin/offers${qs ? `?${qs}` : ""}`);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
