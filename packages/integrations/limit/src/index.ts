// LimitService — encapsula toda a integração com a API Limit (seção 5-11 do escopo original).
// Implementação real prevista para a Fase 2. Este stub documenta o contrato esperado.
//
// Regras que o serviço real deverá respeitar:
// - Só é chamado pelo Worker 1 quando IntegrationConfig("LIMIT_CONSULTA").ativo === true,
//   verificado NO MOMENTO da execução (não em cache antigo — ver seção 10 do doc de arquitetura).
// - Nunca sobrescreve `telefone_original`; grava o resultado em `telefone_atualizado`.
// - Deve respeitar retry configurável (max tentativas, backoff, status HTTP retryable).

export interface LimitLookupResult {
  telefoneAtualizado: string | null;
  respostaBruta: unknown;
}

export interface LimitService {
  isEnabled(): Promise<boolean>;
  lookupPhone(params: { cpf: string; telefoneOriginal: string }): Promise<LimitLookupResult>;
}

export function createLimitService(): LimitService {
  throw new Error("createLimitService: implementação prevista para a Fase 2.");
}
