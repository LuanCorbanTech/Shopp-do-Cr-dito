// WhatsAppValidationService — valida se um telefone possui WhatsApp (seção 12 do escopo original).
// Implementação real prevista para a Fase 3.

export interface WhatsAppValidationResult {
  possuiWhatsapp: boolean;
  respostaBruta: unknown;
}

export interface WhatsAppValidationService {
  validate(telefone: string): Promise<WhatsAppValidationResult>;
}

export function createWhatsAppValidationService(): WhatsAppValidationService {
  throw new Error("createWhatsAppValidationService: implementação prevista para a Fase 3.");
}
