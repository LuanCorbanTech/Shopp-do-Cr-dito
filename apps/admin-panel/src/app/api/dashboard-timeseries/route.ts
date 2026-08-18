import { NextRequest, NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

// Mesmo motivo dos outros proxies (ver dashboard-kpis/route.ts): mantém o
// ADMIN_API_TOKEN fora do navegador.
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
    const data = await adminApiFetch(`/admin/dashboard/timeseries${qs ? `?${qs}` : ""}`);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
