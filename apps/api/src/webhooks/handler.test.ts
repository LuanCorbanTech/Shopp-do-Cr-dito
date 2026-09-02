import { describe, expect, it } from "vitest";
import { handleWebhookRequest, extrairTelefoneOriginal, type RawWebhookPayload } from "./handler";
import { computeSignature, computeSimpleHmac } from "./hmac";
import { createFakeOffersPort } from "./test-support/fake-offers-port";

const NOW = 1_700_000_000;
const SECRET = "segredo-do-webhook";
const WEBHOOK_OFERTAS_V1 = {
  id: "webhook-1",
  identificador: "origem-teste",
  origem: "Origem de Teste",
  secretHmac: SECRET,
  ativo: true,
  esquemaAssinatura: "ofertas_v1",
  headerAssinatura: "x-ofertas-signature",
  headerTimestamp: "x-ofertas-timestamp",
};
const WEBHOOK_SIMPLES = {
  id: "webhook-2",
  identificador: "odysseia",
  origem: "Odysseia",
  secretHmac: SECRET,
  ativo: true,
  esquemaAssinatura: "hmac_sha256_simple",
  headerAssinatura: "x-odysseia-signature",
  headerTimestamp: null,
};

function ofertasV1Headers(rawBody: string, timestamp = NOW) {
  const timestampHeader = String(timestamp);
  return {
    "x-ofertas-timestamp": timestampHeader,
    "x-ofertas-signature": computeSignature(SECRET, timestampHeader, rawBody),
  };
}

function odysseiaHeaders(rawBody: string) {
  return { "x-odysseia-signature": computeSimpleHmac(SECRET, rawBody) };
}

describe("handleWebhookRequest — item único (esquema ofertas_v1)", () => {
  it("cria a oferta com status RECEBIDO em uma requisição válida", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);
    const body = { cpf: "11111111111", telefone: "62999999999", external_id: "abc-1" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: ofertasV1Headers(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome.kind).toBe("single");
    if (outcome.kind === "single") expect(outcome.resultado.kind).toBe("created");
  });

  it("não cria duplicado quando o mesmo CPF chega duas vezes no mesmo webhook (reseta em vez de duplicar)", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);
    const body = { cpf: "11111111111", telefone: "62999999999", external_id: "abc-1" };
    const rawBody = JSON.stringify(body);
    const params = {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: ofertasV1Headers(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    };

    const first = await handleWebhookRequest(port, params);
    const second = await handleWebhookRequest(port, params);

    expect(first.kind).toBe("single");
    expect(second.kind).toBe("single");
    if (first.kind === "single" && second.kind === "single") {
      expect(first.resultado.kind).toBe("created");
      expect(second.resultado.kind).toBe("reset");
      if (first.resultado.kind === "created" && second.resultado.kind === "reset") {
        expect(second.resultado.offerId).toBe(first.resultado.offerId);
      }
    }
  });

  it("rejeita quando o webhook não existe ou está inativo", async () => {
    const { port } = createFakeOffersPort([{ ...WEBHOOK_OFERTAS_V1, ativo: false }]);
    const body = { cpf: "11111111111", telefone: "62999999999" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: ofertasV1Headers(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome.kind).toBe("webhook_not_found");
  });

  it("rejeita assinatura inválida", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);
    const body = { cpf: "11111111111", telefone: "62999999999" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: { "x-ofertas-timestamp": String(NOW), "x-ofertas-signature": "assinatura-forjada" },
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome).toEqual({ kind: "invalid_signature", reason: "signature_mismatch" });
  });

  it("rejeita payload sem cpf", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);
    // Cast proposital: simula um parceiro mandando um payload sem cpf (algo que o
    // TypeScript não deixaria montar direto, mas que pode chegar de verdade vindo
    // de fora — é exatamente esse caso que o guard em tempo de execução cobre).
    const body = { telefone: "62999999999" } as unknown as RawWebhookPayload;
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: ofertasV1Headers(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome.kind).toBe("single");
    if (outcome.kind === "single") expect(outcome.resultado.kind).toBe("invalid_payload");
  });

  it("aceita payload sem telefone, desde que tenha cpf (telefone chega depois via Lemit)", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);
    const body = { cpf: "11111111111" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: ofertasV1Headers(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome.kind).toBe("single");
    if (outcome.kind === "single") expect(outcome.resultado.kind).toBe("created");
  });
});

describe("handleWebhookRequest — esquema hmac_sha256_simple (ex.: Odysseia)", () => {
  it("aceita a assinatura de header único, sem timestamp", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = { telefone: "85992100340", cpf: "85868388372" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: odysseiaHeaders(rawBody),
      toleranceSeconds: 300,
    });

    expect(outcome.kind).toBe("single");
    if (outcome.kind === "single") expect(outcome.resultado.kind).toBe("created");
  });

  it("rejeita quando o header de assinatura está ausente", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = { cpf: "85868388372", telefone: "85992100340" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: {},
      toleranceSeconds: 300,
    });

    expect(outcome).toEqual({ kind: "invalid_signature", reason: "missing_signature" });
  });

  it("rejeita assinatura incorreta", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = { cpf: "85868388372", telefone: "85992100340" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: { "x-odysseia-signature": "0".repeat(64) },
      toleranceSeconds: 300,
    });

    expect(outcome).toEqual({ kind: "invalid_signature", reason: "signature_mismatch" });
  });
});

describe("handleWebhookRequest — lote (array de leads)", () => {
  it("processa cada item do lote de forma independente, mesmo com um item inválido no meio", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = [
      { cpf: "11111111111", telefone: "85992100340", external_id: "lead-1" },
      { cpf: "" }, // inválido (cpf vazio) — não deve invalidar o resto do lote
      { cpf: "22222222222", telefone: "85996888516", external_id: "lead-3" },
    ];
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: odysseiaHeaders(rawBody),
      toleranceSeconds: 300,
    });

    expect(outcome.kind).toBe("batch");
    if (outcome.kind === "batch") {
      expect(outcome.resultados).toHaveLength(3);
      expect(outcome.resultados[0].kind).toBe("created");
      expect(outcome.resultados[1].kind).toBe("invalid_payload");
      expect(outcome.resultados[2].kind).toBe("created");
    }
  });

  it("reenviar o mesmo lote inteiro reseta os itens (mesmo webhook + mesmo CPF nunca duplica — ver regra de reset)", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = [
      { cpf: "11111111111", telefone: "85992100340", external_id: "lead-1" },
      { cpf: "22222222222", telefone: "85996888516", external_id: "lead-2" },
    ];
    const rawBody = JSON.stringify(body);
    const params = {
      identificador: "odysseia",
      rawBody,
      body,
      headers: odysseiaHeaders(rawBody),
      toleranceSeconds: 300,
    };

    const first = await handleWebhookRequest(port, params);
    const second = await handleWebhookRequest(port, params);

    expect(first.kind).toBe("batch");
    expect(second.kind).toBe("batch");
    if (first.kind === "batch" && second.kind === "batch") {
      expect(first.resultados.map((r) => r.kind)).toEqual(["created", "created"]);
      // Mesmo webhook + mesmo CPF de novo -> reseta (não duplica, não fica "parado" como antes)
      expect(second.resultados.map((r) => r.kind)).toEqual(["reset", "reset"]);
    }
  });

  it("um lote inteiro com assinatura inválida é rejeitado antes de processar qualquer item", async () => {
    const { port, offersByKey } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = [{ cpf: "11111111111", telefone: "85992100340" }];
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: { "x-odysseia-signature": "assinatura-forjada" },
      toleranceSeconds: 300,
    });

    expect(outcome.kind).toBe("invalid_signature");
    expect(offersByKey.size).toBe(0);
  });
});

describe("handleWebhookRequest — formato envelope (ex.: Odysseia manda { teste, leads: [...] })", () => {
  it("payload de teste (teste=true) responde ok sem gravar nenhuma oferta", async () => {
    const { port, offersByKey } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = { teste: true, leads: [] as RawWebhookPayload[] };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: odysseiaHeaders(rawBody),
      toleranceSeconds: 300,
    });

    expect(outcome.kind).toBe("test_ping");
    expect(offersByKey.size).toBe(0);
  });

  it("payload de teste com leads de exemplo dentro também não grava nada (teste=true manda, mesmo com leads preenchido)", async () => {
    const { port, offersByKey } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = { teste: true, leads: [{ cpf: "11111111111", nome: "Lead de exemplo" }] };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: odysseiaHeaders(rawBody),
      toleranceSeconds: 300,
    });

    expect(outcome.kind).toBe("test_ping");
    expect(offersByKey.size).toBe(0);
  });

  it("envelope sem teste (ou teste=false) processa os leads de dentro normalmente, como um lote", async () => {
    const { port, offersByKey } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = {
      leads: [
        { cpf: "22222222222", nome: "Lead Um" },
        { cpf: "33333333333", nome: "Lead Dois" },
      ],
    };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: odysseiaHeaders(rawBody),
      toleranceSeconds: 300,
    });

    expect(outcome.kind).toBe("batch");
    if (outcome.kind === "batch") {
      expect(outcome.resultados.map((r) => r.kind)).toEqual(["created", "created"]);
    }
    expect(offersByKey.size).toBe(2);
  });

  it("envelope com assinatura inválida é rejeitado antes de olhar teste/leads", async () => {
    const { port, offersByKey } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = { teste: true, leads: [] as RawWebhookPayload[] };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: { "x-odysseia-signature": "assinatura-forjada" },
      toleranceSeconds: 300,
    });

    expect(outcome.kind).toBe("invalid_signature");
    expect(offersByKey.size).toBe(0);
  });
});

describe("handleWebhookRequest — CPF repetido no mesmo webhook (reset, nunca duplica)", () => {
  it("mesmo webhook + mesmo CPF de novo: reseta a oferta existente em vez de criar outra, mesmo com dados diferentes", async () => {
    const { port, offersByCpf } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);

    const body1 = { cpf: "11111111111", telefone: "62999999999", nome: "João", external_id: "lead-1" };
    const rawBody1 = JSON.stringify(body1);
    const primeira = await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody: rawBody1, body: body1,
      headers: ofertasV1Headers(rawBody1), toleranceSeconds: 300, nowSeconds: NOW,
    });
    expect(primeira.kind).toBe("single");
    if (primeira.kind === "single") expect(primeira.resultado.kind).toBe("created");

    // 2 dias depois: mesmo webhook, mesmo CPF, dados novos, external_id novo
    const body2 = { cpf: "11111111111", telefone: "62988887777", nome: "João Atualizado", external_id: "lead-2" };
    const rawBody2 = JSON.stringify(body2);
    const segunda = await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody: rawBody2, body: body2,
      headers: ofertasV1Headers(rawBody2, NOW + 172800), toleranceSeconds: 300, nowSeconds: NOW + 172800,
    });

    expect(segunda.kind).toBe("single");
    if (segunda.kind === "single") expect(segunda.resultado.kind).toBe("reset");
    // "offersByCpf" é a fonte de verdade de "quantas ofertas distintas existem" —
    // continua sendo 1 (a mesma oferta, resetada), não uma 2ª criada.
    expect(offersByCpf.size).toBe(1);
  });

  it("reseta mesmo que o CPF venha formatado diferente da 1ª vez (com pontuação vs só dígitos)", async () => {
    const { port, offersByCpf } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);

    const body1 = { cpf: "111.111.111-11", telefone: "62999999999", external_id: "lead-1" };
    const rawBody1 = JSON.stringify(body1);
    await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody: rawBody1, body: body1,
      headers: ofertasV1Headers(rawBody1), toleranceSeconds: 300, nowSeconds: NOW,
    });

    const body2 = { cpf: "11111111111", telefone: "62988887777", external_id: "lead-2" }; // mesmo CPF, sem pontuação
    const rawBody2 = JSON.stringify(body2);
    const segunda = await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody: rawBody2, body: body2,
      headers: ofertasV1Headers(rawBody2, NOW + 172800), toleranceSeconds: 300, nowSeconds: NOW + 172800,
    });

    expect(segunda.kind).toBe("single");
    if (segunda.kind === "single") expect(segunda.resultado.kind).toBe("reset");
    expect(offersByCpf.size).toBe(1); // não criou uma 2ª oferta por causa da formatação diferente
  });

  it("webhooks DIFERENTES com o mesmo CPF continuam gerando ofertas separadas (não reseta entre fornecedores)", async () => {
    const WEBHOOK_OUTRO = { ...WEBHOOK_OFERTAS_V1, id: "webhook-outro", identificador: "outro-fornecedor" };
    const { port, offersByCpf } = createFakeOffersPort([WEBHOOK_OFERTAS_V1, WEBHOOK_OUTRO]);

    const body = { cpf: "11111111111", telefone: "62999999999", external_id: "lead-1" };
    const rawBody = JSON.stringify(body);

    const primeira = await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody, body,
      headers: ofertasV1Headers(rawBody), toleranceSeconds: 300, nowSeconds: NOW,
    });
    const segunda = await handleWebhookRequest(port, {
      identificador: "outro-fornecedor", rawBody, body,
      headers: ofertasV1Headers(rawBody), toleranceSeconds: 300, nowSeconds: NOW,
    });

    expect(primeira.kind).toBe("single");
    expect(segunda.kind).toBe("single");
    if (primeira.kind === "single") expect(primeira.resultado.kind).toBe("created");
    if (segunda.kind === "single") expect(segunda.resultado.kind).toBe("created"); // não é "reset"
    expect(offersByCpf.size).toBe(2); // 2 ofertas separadas, uma por webhook
  });
});

describe("extrairTelefoneOriginal — parceiro que manda listas em vez de campo simples (ex.: leilão de crédito, 02/09)", () => {
  it("usa o primeiro número de 'whatsapps' quando não tem campo 'telefone' (payload real da Karina, com os dados sensíveis trocados)", () => {
    const payload: RawWebhookPayload = {
      cpf: "00000000000",
      nome: "Nome Exemplo",
      telefones: ["11911111111", "11922222222"],
      whatsapps: ["11933333333"],
    };
    expect(extrairTelefoneOriginal(payload)).toBe("11933333333");
  });

  it("prioriza o campo 'telefone' simples quando ele vier, mesmo com 'whatsapps' também presente", () => {
    const payload: RawWebhookPayload = {
      cpf: "00000000000",
      telefone: "11900000000",
      whatsapps: ["11933333333"],
    };
    expect(extrairTelefoneOriginal(payload)).toBe("11900000000");
  });

  it("devolve null quando não tem 'telefone' nem 'whatsapps' (parceiro genuinamente não mandou nenhum)", () => {
    expect(extrairTelefoneOriginal({ cpf: "00000000000" })).toBeNull();
  });

  it("devolve null quando 'whatsapps' existe mas é uma lista vazia", () => {
    expect(extrairTelefoneOriginal({ cpf: "00000000000", whatsapps: [] })).toBeNull();
  });

  it("não usa 'telefones' (não confirmados com WhatsApp) como fallback — só 'telefone' e 'whatsapps'", () => {
    const payload: RawWebhookPayload = { cpf: "00000000000", telefones: ["11911111111"] };
    expect(extrairTelefoneOriginal(payload)).toBeNull();
  });
});
