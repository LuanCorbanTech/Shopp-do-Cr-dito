// Cliente da API oficial da Meta (Graph API) usado pelo worker10 pra
// consultar a qualidade/limite dos números de uma WABA (10/09).
//
// Contrato real (fornecido pelo Lucas):
//   GET https://graph.facebook.com/{versao}/{WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status
//   Header: Authorization: Bearer {token do system user do app da BM}
//   Resposta 200: { data: [ { id, display_phone_number, verified_name?, quality_rating, messaging_limit_tier?, status? }, ... ] }
//   Resposta de erro (qualquer status != 2xx): { error: { message, type, code, ... } }
//
// O token é o do APP CRIADO DENTRO DA PRÓPRIA BM (cada BM tem o seu — ver
// BmConta no schema); o WABA_ID muda por WABA dentro da mesma BM (ver
// WabaConta) — por isso os dois vêm sempre juntos aqui, nunca cacheados
// neste módulo (quem decide qual token usar pra qual WABA é o repositório,
// não este cliente).
//
// versaoGraphApi é configurável no painel (Integrações/Qualidade WhatsApp,
// não fixo aqui) porque a Meta aposenta versões antigas da Graph API
// periodicamente — trocar o valor no painel não exige deploy novo.

export interface MetaQualidadeConfig {
  wabaId: string;
  tokenAcesso: string;
  /** Ex.: "v21.0". Sem o "v" também funciona (normalizado abaixo). */
  versaoGraphApi: string;
  timeoutMs?: number;
}

export interface MetaPhoneNumberResult {
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  /** Valor cru da Meta (GREEN | YELLOW | RED | UNKNOWN | NA...) — nunca validado contra uma lista fixa aqui. */
  qualityRating: string;
  messagingLimitTier: string | null;
  status: string | null;
}

export class MetaQualidadeError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null
  ) {
    super(message);
    this.name = "MetaQualidadeError";
  }
}

function normalizarVersao(versao: string): string {
  const limpa = versao.trim();
  if (!limpa) return "v21.0";
  return limpa.startsWith("v") ? limpa : `v${limpa}`;
}

function extrairMensagemErroMeta(body: unknown): string | null {
  const erro = (body as { error?: { message?: string; error_user_msg?: string } } | undefined)?.error;
  return erro?.error_user_msg || erro?.message || null;
}

function mapearNumero(item: unknown): MetaPhoneNumberResult {
  const i = (item ?? {}) as Record<string, unknown>;
  return {
    phoneNumberId: String(i.id ?? ""),
    displayPhoneNumber: typeof i.display_phone_number === "string" ? i.display_phone_number : "",
    verifiedName: typeof i.verified_name === "string" ? i.verified_name : null,
    qualityRating: typeof i.quality_rating === "string" && i.quality_rating ? i.quality_rating : "UNKNOWN",
    messagingLimitTier: typeof i.messaging_limit_tier === "string" ? i.messaging_limit_tier : null,
    status: typeof i.status === "string" ? i.status : null,
  };
}

// Sem paginação por enquanto: cada WABA raramente tem mais que uma dúzia de
// números (o campo "paging" da Meta pode trazer mais de uma página em casos
// extremos — se isso virar um problema real, dá pra seguir paging.next
// aqui, sem precisar mudar nada fora deste arquivo).
export async function buscarNumerosWhatsappMeta(config: MetaQualidadeConfig): Promise<MetaPhoneNumberResult[]> {
  const versao = normalizarVersao(config.versaoGraphApi);
  const url = `https://graph.facebook.com/${versao}/${encodeURIComponent(config.wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.tokenAcesso}` },
      signal: controller.signal,
    });
  } catch (error) {
    throw new MetaQualidadeError(
      `Falha de rede ao consultar a Meta: ${error instanceof Error ? error.message : String(error)}`,
      null
    );
  } finally {
    clearTimeout(timeout);
  }

  const textoBruto = await response.text();
  let corpo: unknown = {};
  if (textoBruto) {
    try {
      corpo = JSON.parse(textoBruto);
    } catch {
      corpo = { raw: textoBruto };
    }
  }

  if (!response.ok) {
    const mensagem = extrairMensagemErroMeta(corpo) ?? `HTTP ${response.status}`;
    throw new MetaQualidadeError(mensagem, response.status);
  }

  const dados = (corpo as { data?: unknown[] }).data;
  if (!Array.isArray(dados)) return [];
  return dados.map(mapearNumero);
}
