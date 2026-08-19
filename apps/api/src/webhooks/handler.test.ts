import { describe, expect, it } from "vitest";
import { handleWebhookRequest, type RawWebhookPayload } from "./handler";
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

  it("não cria duplicado quando a mesma oferta chega duas vezes (idempotência)", async () => {
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
      expect(second.resultado.kind).toBe("duplicate");
      if (first.resultado.kind === "created" && second.resultado.kind === "duplicate") {
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

  it("reenviar o mesmo lote inteiro não duplica nada (idempotência por item)", async () => {
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
      expect(second.resultados.map((r) => r.kind)).toEqual(["duplicate", "duplicate"]);
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
