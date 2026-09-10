import { NextRequest, NextResponse } from "next/server";
import { adminApiFetch, AdminApiError } from "@/lib/api";

function extrairMensagem(e: unknown): string {
  if (e instanceof AdminApiError) return e.friendlyMessage ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

export async function GET(request: NextRequest) {
  try {
    const cpf = request.nextUrl.searchParams.get("cpf");
    if (!cpf) {
      return NextResponse.json({ error: "cpf_obrigatorio", mensagem: "Informe um CPF." }, { status: 400 });
    }
    const data = await adminApiFetch(`/admin/integrations/facta-margem/testar?cpf=${encodeURIComponent(cpf)}`);
    return NextResponse.json(data);
  } catch (e) {
    const mensagem = extrairMensagem(e);
    return NextResponse.json({ error: mensagem, mensagem }, { status: 502 });
  }
}

