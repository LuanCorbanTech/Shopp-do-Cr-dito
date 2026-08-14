import { describe, expect, it } from "vitest";
import { handleWebhookOffer } from "./handler";
import { computeSignature } from "./hmac";
import { createFakeOffersPort } from "./test-support/fake-offers-port";

const NOW = 1_700_000_000;
const SECRET = "segredo-do-webhook";
const WEBHOOK = {
  id: "webhook-1",
  identificador: "origem-teste",
  origem: "Origem de Teste",
  secretHmac: SECRET,
  ativo: true,
};

function signedHeaders(rawBody: string, timestamp = NOW) {
  const timestampHeader = String(timestamp);
  return {
    timestamp: timestampHeader,
    signature: computeSignature(SECRET, timestampHeader, rawBody),
  };
}

describe("handleWebhookOffer", () => {
  it("cria a oferta com status RECEBIDO em uma requisição válida", async () => {
    const { port } = createFakeOffersPort([WEBHOOK]);
    const body = { telefone: "62999999999", external_id: "abc-1" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookOffer(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: signedHeaders(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome.kind).toBe("created");
  });

  it("não cria duplicado quando a mesma oferta chega duas vezes (idempotência)", async () => {
    const { port } = createFakeOffersPort([WEBHOOK]);
    const body = { telefone: "62999999999", external_id: "abc-1" };
    const rawBody = JSON.stringify(body);
    const params = {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: signedHeaders(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    };

    const first = await handleWebhookOffer(port, params);
    const second = await handleWebhookOffer(port, params);

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("duplicate");
    if (first.kind === "created" && second.kind === "duplicate") {
      expect(second.offerId).toBe(first.offerId);
    }
  });

  it("rejeita quando o webhook não existe ou está inativo", async () => {
    const { port } = createFakeOffersPort([{ ...WEBHOOK, ativo: false }]);
    const body = { telefone: "62999999999" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookOffer(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: signedHeaders(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome.kind).toBe("webhook_not_found");
  });

  it("rejeita assinatura inválida", async () => {
    const { port } = createFakeOffersPort([WEBHOOK]);
    const body = { telefone: "62999999999" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookOffer(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: { timestamp: String(NOW), signature: "assinatura-forjada" },
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome.kind).toBe("invalid_signature");
  });

  it("rejeita payload sem telefone", async () => {
    const { port } = createFakeOffersPort([WEBHOOK]);
    const body = { telefone: "" };
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookOffer(port, {
      identificador: "origem-teste",
      rawBody,
      body,
      headers: signedHeaders(rawBody),
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });

    expect(outcome.kind).toBe("invalid_payload");
  });
});
