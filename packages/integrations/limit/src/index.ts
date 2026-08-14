// LimitService — integração real com a Lemit (api.lemit.com.br), usada pelo Worker 1
// para enriquecer o lead antes da validação de WhatsApp: consulta por CPF e devolve
// dados cadastrais completos da pessoa, incluindo os celulares conhecidos (usados
// pra decidir o telefoneAtualizado). O nome interno do pacote/variáveis continua
// "Limit" — herdado de antes de sabermos o nome real do provedor; é só nome de
// código, não afeta nada externamente.
//
// Contrato real (exemplo de requisição/resposta fornecido no chat — ainda sem
// documentação formal em PDF, diferente da CorbanTech):
//   POST https://api.lemit.com.br/api/v1/consulta/pessoa
//   Headers: { Authorization: "Bearer <token>" }
//   Body:    { documento: "<CPF, só dígitos>" }
//   Resposta 200: { data_consulta, pessoa: { cpf, nome, celulares: [...], ... } }
//
// A escolha de QUAL celular usar como telefoneAtualizado é lógica pura e fica em
// @plataforma-ofertas/domain (escolherMelhorTelefoneLemit) — testável e reaproveitável
// sem precisar de HTTP.

import { escolherMelhorTelefoneLemit } from "@plataforma-ofertas/domain";

export interface LimitLookupParams {
  /** CPF do lead — único campo que a Lemit precisa; sem ele não há como consultar. */
  documento: string;
}

export interface LimitLookupResult {
  telefoneAtualizado: string | null;
  /** Segundo a própria Lemit (informativo) — não substitui a validação oficial do Worker 2. */
  possuiWhatsappSegundoLemit: boolean | null;
  /** Objeto "pessoa" completo devolvido pela Lemit — pra salvar direto no registro do lead. */
  dadosPessoa: Record<string, unknown> | null;
  /** Resposta HTTP crua completa — pra auditoria (phone_validations.resposta_limit). */
  respostaBruta: unknown;
  httpStatus: number | null;
}

export interface LimitServiceConfig {
  /** Raiz do serviço. Padrão: a própria Lemit — só precisa mudar em teste/mocks. */
  baseUrl?: string;
  /** Header Authorization: Bearer <apiKey> — obrigatório, a Lemit sempre exige. */
  apiKey: string;
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

const LEMIT_DEFAULT_BASE_URL = "https://api.lemit.com.br";

export function createLimitService(config: LimitServiceConfig): LimitService {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const baseUrl = (config.baseUrl || LEMIT_DEFAULT_BASE_URL).replace(/\/$/, "");

  return {
    async lookupPhone({ documento }: LimitLookupParams): Promise<LimitLookupResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/api/v1/consulta/pessoa`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ documento: documento.replace(/\D/g, "") }),
          signal: controller.signal,
        });
        const respostaBruta = await safeParseJson(response);
        if (!response.ok) {
          throw new LimitServiceError(`API Lemit respondeu ${response.status}`, response.status, respostaBruta);
        }

        const pessoa = extractPessoa(respostaBruta);
        const escolhido = escolherMelhorTelefoneLemit(pessoa?.celulares);

        return {
          telefoneAtualizado: escolhido?.telefone ?? null,
          possuiWhatsappSegundoLemit: escolhido?.possuiWhatsappSegundoLemit ?? null,
          dadosPessoa: pessoa,
          respostaBruta,
          httpStatus: response.status,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

// A Lemit devolve { pessoa: {...} } direto na resposta HTTP. O exemplo fornecido no
// chat veio aninhado em { body: { pessoa: {...} }, headers: {...}, statusCode }, que
// parece ser um wrapper da ferramenta usada pra capturar o exemplo (não da API em
// si) — por segurança, aceitamos as duas formas.
function extractPessoa(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  if (obj.pessoa && typeof obj.pessoa === "object") return obj.pessoa as Record<string, unknown>;
  if (obj.body && typeof obj.body === "object") {
    const body = obj.body as Record<string, unknown>;
    if (body.pessoa && typeof body.pessoa === "object") return body.pessoa as Record<string, unknown>;
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
