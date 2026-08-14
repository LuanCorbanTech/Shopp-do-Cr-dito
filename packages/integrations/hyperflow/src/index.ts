import { createHmac } from "node:crypto";
import { resolveSecret } from "@plataforma-ofertas/shared";
import type { EndpointSnapshot } from "@plataforma-ofertas/domain";

// HyperflowService — único ponto de integração com a Hyperflow (seção 23 do escopo
// original): autenticação, headers, payload, timeout, retry (a tentativa em si — a
// política de quantas vezes tentar é do Worker 5) e logs vivem só aqui.
//
// Simplificação assumida (documentada por não haver contrato da Hyperflow no escopo):
// este serviço despacha diretamente para `endpoint.url` usando a autenticação
// configurada no próprio Endpoint (itens 18-19), em vez de chamar um gateway
// intermediário da Hyperflow. Se a Hyperflow real for um gateway que recebe a rota
// como parâmetro, a única mudança necessária é o `fetch` abaixo (trocar a URL alvo
// por HYPERFLOW_BASE_URL e incluir o endpoint de destino no payload).

export interface DispatchRequest {
  offerId: string;
  endpoint: EndpointSnapshot;
  telefone: string;
  payload: Record<string, unknown>;
}

export interface DispatchResult {
  sucesso: boolean;
  httpStatus: number | null;
  request: Record<string, unknown>;
  respostaBruta: unknown;
}

export interface HyperflowService {
  dispatch(request: DispatchRequest): Promise<DispatchResult>;
}

export function createHyperflowService(): HyperflowService {
  return {
    async dispatch({ endpoint, telefone, payload }: DispatchRequest): Promise<DispatchResult> {
      const timeoutMs = endpoint.timeoutMs ?? 10_000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const body = { telefone, ...payload };
      const bodyString = JSON.stringify(body);
      const headers = buildHeaders(endpoint, bodyString);

      try {
        const response = await fetch(endpoint.url, {
          method: endpoint.metodoHttp || "POST",
          headers,
          body: endpoint.metodoHttp === "GET" ? undefined : bodyString,
          signal: controller.signal,
        });
        const respostaBruta = await safeParseJson(response);
        return {
          sucesso: response.ok,
          httpStatus: response.status,
          request: { url: endpoint.url, method: endpoint.metodoHttp, body },
          respostaBruta,
        };
      } catch (error) {
        return {
          sucesso: false,
          httpStatus: null,
          request: { url: endpoint.url, method: endpoint.metodoHttp, body },
          respostaBruta: error instanceof Error ? { erro: error.message } : error,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function buildHeaders(endpoint: EndpointSnapshot, bodyString: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(endpoint.headers ?? {}),
  };

  const secret = resolveSecret(endpoint.credenciaisRef);
  if (!secret) return headers;

  switch (endpoint.authType) {
    case "API_KEY":
      headers["X-Api-Key"] = secret;
      break;
    case "BEARER_TOKEN":
      headers["Authorization"] = `Bearer ${secret}`;
      break;
    case "BASIC":
      headers["Authorization"] = `Basic ${Buffer.from(secret).toString("base64")}`;
      break;
    case "HMAC": {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac("sha256", secret).update(`${timestamp}.${bodyString}`).digest("hex");
      headers["X-Timestamp"] = timestamp;
      headers["X-Signature"] = signature;
      break;
    }
    case "NONE":
    default:
      break;
  }

  return headers;
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
