// WhatsAppValidationService — cliente da "API de Validação de WhatsApp" da
// CorbanTech (documentação: docs/integrations/APIValidacaoWhatsAppCorbanTech.pdf,
// v1.1, agosto de 2026). Contrato REAL (não é mais um contrato genérico assumido).
//
// A API é assíncrona em duas etapas:
//   1) POST /api/v1/whatsapp/check  -> HTTP 202 imediato com { request_id }.
//   2) O resultado chega depois, OU por webhook (se houver callback_url/URL padrão
//      cadastrada), OU consultando manualmente GET /api/v1/whatsapp/check/{request_id}
//      (disponível por 14 dias).
//
// Este arquivo só cobre a ETAPA 1 do plano (a "conexão"): os dois métodos HTTP.
// Ainda NÃO inclui: o endpoint que recebe o webhook de callback, nem a integração
// com o Worker 2 (que hoje assume validação síncrona) — isso é a próxima etapa,
// já que exige mudar o fluxo de RECEBIDO->VALIDANDO_WHATSAPP->resultado para um
// modelo "iniciar consulta, aguardar callback/poll".

export type WhatsAppCheckStatus = "processing" | "done" | "error";

export interface StartWhatsAppCheckParams {
  /** Só dígitos são considerados pela API; pode incluir ou não o DDI. */
  phone: string;
  /** Código do país, se `phone` não incluir o DDI. Padrão da API: 55 (Brasil). */
  ddi?: string;
  /** Sobrescreve a URL padrão do time só para esta consulta. */
  callbackUrl?: string;
}

export interface StartWhatsAppCheckResult {
  requestId: string;
  /** Telefone normalizado pela API (com DDI), como veio na resposta. */
  phone: string;
  httpStatus: number;
}

export interface WhatsAppCheckResult {
  status: WhatsAppCheckStatus;
  requestId: string;
  phone?: string;
  /** Só presente quando status === "done". */
  hasWhatsapp?: boolean;
  /** Presente quando status === "error" (mensagem pronta para exibição). */
  message?: string;
  httpStatus: number;
}

export interface WhatsAppValidationServiceConfig {
  /** Raiz do serviço, ex.: "https://SEU-DOMINIO" — sem o "/api/v1/...". */
  baseUrl: string;
  /** Header X-API-Key (credencial individual do time, formato cbk_live_...). */
  apiKey: string;
  timeoutMs?: number;
}

export interface WhatsAppValidationService {
  /** Inicia a consulta. Resposta imediata (HTTP 202) — ainda sem o resultado. */
  startCheck(params: StartWhatsAppCheckParams): Promise<StartWhatsAppCheckResult>;
  /** Consulta manual do resultado por request_id (fallback ao webhook). */
  getCheckResult(requestId: string): Promise<WhatsAppCheckResult>;
}

/**
 * Erro da API. `errorCode` é um dos códigos documentados na seção 05
 * (ex.: "telefone_invalido", "chave_invalida", "limite_excedido") quando a API
 * retornou um corpo reconhecível; `retryAfterSeconds` só é preenchido em 429
 * (header Retry-After).
 */
export class WhatsAppValidationError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly errorCode: string | null,
    public readonly retryAfterSeconds: number | null,
    public readonly respostaBruta: unknown
  ) {
    super(message);
    this.name = "WhatsAppValidationError";
  }
}

export function createWhatsAppValidationService(
  config: WhatsAppValidationServiceConfig
): WhatsAppValidationService {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  async function request(path: string, init: RequestInit): Promise<{ status: number; body: unknown; retryAfterSeconds: number | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          "X-API-Key": config.apiKey,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const body = await safeParseJson(response);
      const retryAfterHeader = response.headers.get("Retry-After");
      return {
        status: response.status,
        body,
        retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function throwIfError(result: { status: number; body: unknown; retryAfterSeconds: number | null }): void {
    if (result.status >= 200 && result.status < 300) return;
    const bodyObj = (result.body && typeof result.body === "object" ? result.body : {}) as Record<string, unknown>;
    const errorCode = typeof bodyObj.error === "string" ? bodyObj.error : null;
    const message =
      typeof bodyObj.message === "string"
        ? bodyObj.message
        : `API de validação de WhatsApp respondeu ${result.status}`;
    throw new WhatsAppValidationError(message, result.status, errorCode, result.retryAfterSeconds, result.body);
  }

  return {
    async startCheck(params: StartWhatsAppCheckParams): Promise<StartWhatsAppCheckResult> {
      const payload: Record<string, unknown> = { phone: params.phone };
      if (params.ddi) payload.ddi = params.ddi;
      if (params.callbackUrl) payload.callback_url = params.callbackUrl;

      const result = await request("/api/v1/whatsapp/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      throwIfError(result);

      const body = result.body as Record<string, unknown>;
      return {
        requestId: String(body.request_id),
        phone: String(body.phone),
        httpStatus: result.status,
      };
    },

    async getCheckResult(requestId: string): Promise<WhatsAppCheckResult> {
      const result = await request(`/api/v1/whatsapp/check/${encodeURIComponent(requestId)}`, {
        method: "GET",
      });
      throwIfError(result);

      const body = result.body as Record<string, unknown>;
      return {
        status: body.status as WhatsAppCheckStatus,
        requestId: String(body.request_id ?? requestId),
        phone: typeof body.phone === "string" ? body.phone : undefined,
        hasWhatsapp: typeof body.has_whatsapp === "boolean" ? body.has_whatsapp : undefined,
        message: typeof body.message === "string" ? body.message : undefined,
        httpStatus: result.status,
      };
    },
  };
}

async function safeParseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
