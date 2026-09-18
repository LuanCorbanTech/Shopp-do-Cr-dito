import { NextRequest, NextResponse } from "next/server";
import { AdminApiError, adminApiFetch } from "@/lib/api";

// Proxy server-side pra tela "Subir Base" (18/09). O parse do .xlsx acontece
// no navegador (SubirBaseClient.tsx, lib xlsx) — aqui só repassa o resultado
// já extraído pra API administrativa (apps/api), que faz a validação final
// e grava o lote + as linhas. POST em vez de Server Action de propósito: o
// corpo pode ser grande (planilhas com muitas linhas), e Server Actions do
// Next.js têm um limite de tamanho de corpo próprio (1MB por padrão) que uma
// Route Handler comum não tem.
export async function GET() {
  try {
    const data = await adminApiFetch("/admin/lotes-upload");
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const corpo = await request.text();
  try {
    const data = await adminApiFetch("/admin/lotes-upload", { method: "POST", body: corpo });
    return NextResponse.json(data, { status: 201 });
  } catch (e) {
    if (e instanceof AdminApiError) {
      const mensagem = e.friendlyMessage ?? `A API respondeu ${e.status}.`;
      return NextResponse.json({ error: mensagem }, { status: e.status });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
