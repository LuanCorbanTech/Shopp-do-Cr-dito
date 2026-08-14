// HyperflowService — único ponto de integração com a Hyperflow (seção 23 do escopo original).
// Toda autenticação, montagem de payload, timeout, retry e logs da Hyperflow vivem aqui,
// nunca espalhados pelos workers. Implementação real prevista para a Fase 5.

export interface DispatchRequest {
  offerId: string;
  endpointId: string;
  telefone: string;
  payload: Record<string, unknown>;
}

export interface DispatchResult {
  sucesso: boolean;
  httpStatus: number | null;
  respostaBruta: unknown;
}

export interface HyperflowService {
  dispatch(request: DispatchRequest): Promise<DispatchResult>;
}

export function createHyperflowService(): HyperflowService {
  throw new Error("createHyperflowService: implementação prevista para a Fase 5.");
}
