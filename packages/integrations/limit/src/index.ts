// LimitService — encapsula toda a integração com a API Limit (seção 5-11 do escopo
// original). O contrato exato (rota, payload, campos de resposta) depende do provedor
// real; como o escopo não define isso, este cliente assume um contrato REST simples
// e razoável (POST {baseUrl}/lookup, resposta com { telefone }). Ajuste extractPhone/
// a rota quando a documentação real da API Limit estiver disponível — é a única
// mudança necessária, isolada neste arquivo.

export interface LimitLookupParams {
  cpf: string | null;
  telefoneOriginal: string;
}

export interface LimitLookupResult {
  telefoneAtualizado: string | null;
  respostaBruta: unknown;
  httpStatus: number | null;
}

export interface LimitServiceConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface LimitService {
  lookupPhone(params: LimitLookupParams): Promise<LimitLookupResult>;
}

export class LimitServiceError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly respostaBruta: unknown
  ) {
    super(message);
    this.name = "LimitServiceError";
  }
}

export function createLimitService(config: LimitServiceConfig): LimitService {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  return {
    async lookupPhone({ cpf, telefoneOriginal }: LimitLookupParams): Promise<LimitLookupResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/lookup`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ cpf, telefone: telefoneOriginal }),
          signal: controller.signal,
        });
        const respostaBruta = await safeParseJson(response);
        if (!response.ok) {
          throw new LimitServiceError(`API Limit respondeu ${response.status}`, response.status, respostaBruta);
        }
        return {
          telefoneAtualizado: extractPhone(respostaBruta),
          respostaBruta,
          httpStatus: response.status,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function extractPhone(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "telefone" in (payload as Record<string, unknown>)) {
    const value = (payload as Record<string, unknown>).telefone;
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
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
