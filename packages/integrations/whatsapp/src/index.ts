// WhatsAppValidationService — valida se um telefone possui WhatsApp (seção 12 do
// escopo original). Mesmo aviso do LimitService: contrato REST assumido (POST
// {baseUrl}/validate, resposta com { possui_whatsapp: boolean }) até a API real
// escolhida ser documentada.

export interface WhatsAppValidationResult {
  possuiWhatsapp: boolean;
  respostaBruta: unknown;
  httpStatus: number | null;
}

export interface WhatsAppValidationServiceConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface WhatsAppValidationService {
  validate(telefone: string): Promise<WhatsAppValidationResult>;
}

export class WhatsAppValidationError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
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

  return {
    async validate(telefone: string): Promise<WhatsAppValidationResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/validate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ telefone }),
          signal: controller.signal,
        });
        const respostaBruta = await safeParseJson(response);
        if (!response.ok) {
          throw new WhatsAppValidationError(
            `API de validação de WhatsApp respondeu ${response.status}`,
            response.status,
            respostaBruta
          );
        }
        return {
          possuiWhatsapp: extractPossuiWhatsapp(respostaBruta),
          respostaBruta,
          httpStatus: response.status,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function extractPossuiWhatsapp(payload: unknown): boolean {
  if (payload && typeof payload === "object" && "possui_whatsapp" in (payload as Record<string, unknown>)) {
    return Boolean((payload as Record<string, unknown>).possui_whatsapp);
  }
  return false;
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
