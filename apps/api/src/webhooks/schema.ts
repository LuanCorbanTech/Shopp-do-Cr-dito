// JSON Schema (Ajv, validado nativamente pelo Fastify) para a rota de ingestão.
// Campos conforme item 2 do escopo original. Só "telefone" é obrigatório —
// o restante é aceito como opcional para não travar origens que enviam payloads
// parciais; `additionalProperties: true` porque "dados adicionais" é livre e o
// payload inteiro é preservado em payload_original de qualquer forma.
//
// O corpo aceita UM lead (objeto) OU um lote de vários leads (array de objetos) —
// alguns parceiros mandam em lote e reenviam o lote inteiro se não responder 2xx a
// tempo (ver handler.ts).

const leadSchema = {
  type: "object",
  required: ["telefone"],
  properties: {
    nome: { type: "string" },
    cpf: { type: "string" },
    telefone: { type: "string", minLength: 8 },
    banco_autorizado: { type: "string" },
    external_id: { type: "string" },
    idempotency_key: { type: "string" },
    produto: { type: "string" },
    valor: { type: "number" },
    parcelas: { type: "integer" },
    origem: { type: "string" },
    data_hora: { type: "string" },
    dados_adicionais: { type: "object" },
  },
  additionalProperties: true,
} as const;

export const webhookParamsSchema = {
  type: "object",
  required: ["identificador"],
  properties: {
    identificador: { type: "string", minLength: 1 },
  },
} as const;

export const webhookBodySchema = {
  oneOf: [leadSchema, { type: "array", items: leadSchema, minItems: 1 }],
} as const;
