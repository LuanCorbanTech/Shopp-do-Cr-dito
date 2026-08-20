"use server";

import { revalidatePath } from "next/cache";
import { adminApiFetch } from "@/lib/api";

export async function setLimitEnabled(ativo: boolean): Promise<void> {
  await adminApiFetch("/admin/integrations/limit", {
    method: "POST",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath("/integracoes");
}

// Salva a credencial da Lemit ou da CorbanTech (WhatsApp), o intervalo do
// CRON em segundos, o limite de requisições por ciclo (rate limit), e — só
// pra WhatsApp — os 3 parâmetros do lote de validação.
// Campos vazios no formulário = "não trocar o que já estava" (evita apagar
// a credencial/intervalo/limite por engano ao só atualizar outro campo).
export async function salvarCredenciais(integracao: "lemit" | "whatsapp", formData: FormData): Promise<void> {
  const apiKey = String(formData.get("apiKey") ?? "");
  const baseUrl = String(formData.get("baseUrl") ?? "");
  const intervaloRaw = String(formData.get("intervaloSegundos") ?? "").trim();
  const intervaloSegundos = intervaloRaw !== "" ? Number(intervaloRaw) : undefined;
  const limiteRaw = String(formData.get("limiteRequisicoesPorCiclo") ?? "").trim();
  const limiteRequisicoesPorCiclo = limiteRaw !== "" ? Number(limiteRaw) : undefined;
  const loteMinimoRaw = String(formData.get("loteMinimo") ?? "").trim();
  const loteMinimo = loteMinimoRaw !== "" ? Number(loteMinimoRaw) : undefined;
  const loteMaximoRaw = String(formData.get("loteMaximo") ?? "").trim();
  const loteMaximo = loteMaximoRaw !== "" ? Number(loteMaximoRaw) : undefined;
  const tempoMaximoRaw = String(formData.get("tempoMaximoEsperaLoteHoras") ?? "").trim();
  const tempoMaximoEsperaLoteHoras = tempoMaximoRaw !== "" ? Number(tempoMaximoRaw) : undefined;
  await adminApiFetch("/admin/integrations/credenciais", {
    method: "POST",
    body: JSON.stringify({
      integracao,
      apiKey,
      baseUrl,
      intervaloSegundos,
      limiteRequisicoesPorCiclo,
      loteMinimo,
      loteMaximo,
      tempoMaximoEsperaLoteHoras,
    }),
  });
  revalidatePath("/integracoes");
}

// Relatório periódico (novo, painel "Integrações"): liga/desliga a integração e
// salva o endpoint, a frequência (em horas) e a janela de horário permitida
// (horaInicio/horaFim, "HH:MM" em Brasília — pra não enviar de madrugada) que o
// worker7 usa pra decidir quando enviar o próximo relatório do dia.

export async function toggleRelatorioPeriodico(ativo: boolean): Promise<void> {
  await adminApiFetch("/admin/integrations/relatorio-periodico", {
    method: "POST",
    body: JSON.stringify({ ativo }),
  });
  revalidatePath("/integracoes");
}

export async function salvarRelatorioPeriodico(formData: FormData): Promise<void> {
  const endpointUrl = String(formData.get("endpointUrl") ?? "");
  const intervaloRaw = String(formData.get("intervaloHoras") ?? "").trim();
  const intervaloHoras = intervaloRaw !== "" ? Number(intervaloRaw) : undefined;
  const horaInicio = String(formData.get("horaInicio") ?? "");
  const horaFim = String(formData.get("horaFim") ?? "");
  await adminApiFetch("/admin/integrations/relatorio-periodico", {
    method: "POST",
    body: JSON.stringify({ endpointUrl, intervaloHoras, horaInicio, horaFim }),
  });
  revalidatePath("/integracoes");
}
