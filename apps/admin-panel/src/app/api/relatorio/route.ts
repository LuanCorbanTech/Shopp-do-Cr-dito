import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { adminApiFetch } from "@/lib/api";
import { formatarData, formatarDataHora } from "@/lib/data-hora";

// Mesmos campos do modal "Ver tudo" da tela de Ofertas — reaproveitados aqui
// pra virar colunas da planilha (pedido explícito de estrutura de colunas).
interface OfferParaRelatorio {
  nome: string | null;
  cpf: string | null;
  sexo: string | null;
  nomeMae: string | null;
  dataNascimento: string | null;
  email: string | null;
  telefoneOriginal: string | null;
  telefoneLemit: string | null;
  whatsappLemit: boolean | null;
  telefoneValidado: string | null;
  possuiWhatsapp: boolean | null;
  endereco: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  externalId: string | null;
  bancoAutorizado: string | null;
  produto: string | null;
  valor: number | null;
  parcelas: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function simNaoOuVazio(valor: boolean | null): string {
  if (valor === true) return "Sim";
  if (valor === false) return "Não";
  return "";
}

// Delega pro helper compartilhado (@/lib/data-hora), que fixa o fuso em
// America/Sao_Paulo explicitamente — antes, sem "timeZone" no
// toLocaleString/toLocaleDateString, essas duas funções rodavam no fuso do
// SERVIDOR (o droplet, em UTC), então o relatório baixado mostrava a hora
// certa do banco só por coincidência, quando o servidor estava em UTC-3;
// no droplet em UTC, vinha 3h adiantado. Mantém "" em vez de "—" pra não
// mudar o formato de célula vazia que a planilha já usava.
function fmtData(iso: string | null): string {
  const texto = formatarData(iso);
  return texto === "—" ? "" : texto;
}

function fmtDataHora(iso: string): string {
  const texto = formatarDataHora(iso);
  return texto === "—" ? "" : texto;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  let ofertas: OfferParaRelatorio[];
  try {
    ofertas = await adminApiFetch<OfferParaRelatorio[]>(`/admin/offers/export?${qs.toString()}`);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  const linhas = ofertas.map((o) => ({
    // Dados pessoais
    Nome: o.nome ?? "",
    CPF: o.cpf ?? "",
    Sexo: o.sexo ?? "",
    "Nome da Mãe": o.nomeMae ?? "",
    "Data de Nascimento": fmtData(o.dataNascimento),
    "E-mail": o.email ?? "",
    // Telefone / WhatsApp
    "Telefone Recebido (Captação)": o.telefoneOriginal ?? "",
    "Telefone (Lemit)": o.telefoneLemit ?? "",
    "Tem WhatsApp (Lemit)": simNaoOuVazio(o.whatsappLemit),
    "Telefone Validado (WhatsApp)": o.telefoneValidado ?? "",
    "Validação Oficial de WhatsApp": simNaoOuVazio(o.possuiWhatsapp),
    // Endereço
    "Endereço Completo": o.endereco ?? "",
    Logradouro: o.logradouro ?? "",
    Número: o.numero ?? "",
    Complemento: o.complemento ?? "",
    Bairro: o.bairro ?? "",
    Cidade: o.cidade ?? "",
    UF: o.uf ?? "",
    CEP: o.cep ?? "",
    // Oferta / sistema
    "ID Externo": o.externalId ?? "",
    "Banco Autorizado": o.bancoAutorizado ?? "",
    Produto: o.produto ?? "",
    Valor: o.valor ?? "",
    Parcelas: o.parcelas ?? "",
    Status: o.status,
    "Data de Criação": fmtDataHora(o.createdAt),
    "Data de Atualização": fmtDataHora(o.updatedAt),
  }));

  const planilha = XLSX.utils.json_to_sheet(linhas.length > 0 ? linhas : [{ Aviso: "Nenhuma oferta encontrada com esse filtro." }]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, planilha, "Ofertas");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const nomeArquivo = `relatorio-ofertas-${new Date().toISOString().slice(0, 10)}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nomeArquivo}"`,
    },
  });
}
