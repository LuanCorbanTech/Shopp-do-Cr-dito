import { NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

// Proxy server-side pro "total geral" (pedido explícito 14/09, sem quebra
// por parceiro) de leads descartados por duplicidade dentro de 24h.
export async function GET() {
  try {
    const data = await adminApiFetch<{ total: number }>("/admin/webhooks/leads-descartados");
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
