import { NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

// Mesmo motivo dos outros proxies em /api/*: mantém o ADMIN_API_TOKEN fora
// do navegador — o painel chama essa rota (server-side aqui), que por sua
// vez chama o backend de verdade com a chave.
export async function GET() {
  try {
    const data = await adminApiFetch("/admin/offers/diagnostico-whatsapp-validado");
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
