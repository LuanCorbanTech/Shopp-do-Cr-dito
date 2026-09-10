import { NextRequest, NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

export async function GET(request: NextRequest) {
  try {
    const cpf = request.nextUrl.searchParams.get("cpf");
    const nome = request.nextUrl.searchParams.get("nome");
    const celular = request.nextUrl.searchParams.get("celular");
    if (!cpf || !nome || !celular) {
      return NextResponse.json({ error: "campos_obrigatorios", mensagem: "Informe cpf, nome e celular." }, { status: 400 });
    }
    const qs = new URLSearchParams({ cpf, nome, celular }).toString();
    const data = await adminApiFetch(`/admin/integrations/facta-margem/testar-online?${qs}`);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
