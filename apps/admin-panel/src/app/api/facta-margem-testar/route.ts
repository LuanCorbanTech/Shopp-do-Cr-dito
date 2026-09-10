import { NextRequest, NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

export async function GET(request: NextRequest) {
  try {
    const cpf = request.nextUrl.searchParams.get("cpf");
    if (!cpf) {
      return NextResponse.json({ error: "cpf_obrigatorio", mensagem: "Informe um CPF." }, { status: 400 });
    }
    const data = await adminApiFetch(`/admin/integrations/facta-margem/testar?cpf=${encodeURIComponent(cpf)}`);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
