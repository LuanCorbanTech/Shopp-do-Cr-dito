import { NextRequest, NextResponse } from "next/server";
import { adminApiFetch, AdminApiError } from "@/lib/api";

function extrairMensagem(e: unknown): string {
  if (e instanceof AdminApiError) return e.friendlyMessage ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

export async function POST(request: NextRequest) {
  try {
    const { wabaContaId } = (await request.json()) as { wabaContaId?: string };
    if (!wabaContaId) {
      return NextResponse.json({ error: "waba_conta_id_obrigatorio", mensagem: "wabaContaId é obrigatório." }, { status: 400 });
    }
    const data = await adminApiFetch(`/admin/qualidade-whatsapp/wabas/${wabaContaId}/testar`, { method: "POST" });
    return NextResponse.json(data);
  } catch (e) {
    const mensagem = extrairMensagem(e);
    return NextResponse.json({ error: mensagem, mensagem }, { status: 502 });
  }
}
