import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebhookRequest, extrairTelefoneOriginal, extrairBancoAutorizado, type RawWebhookPayload } from "./handler";
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

  it("não cria duplicado quando o mesmo CPF chega duas vezes em seguida no mesmo webhook — descarta, ainda dentro de 24h (pedido explícito 14/09)", async () => {
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
      // Reenvio em seguida (mesmo instante) — ainda dentro da janela de 24h,
      // então descarta (não duplica, e NÃO reseta ainda: só reseta depois de
      // 24h — ver describe "CPF repetido" abaixo).
      expect(second.resultado.kind).toBe("discarded");
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

  it("reenviar o mesmo lote inteiro em seguida descarta os itens (mesmo webhook + mesmo CPF dentro de 24h nunca duplica nem reseta ainda — pedido explícito 14/09)", async () => {
    const { port, descartes } = createFakeOffersPort([WEBHOOK_SIMPLES]);
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
      // Mesmo webhook + mesmo CPF de novo, em seguida (dentro de 24h) ->
      // descarta os dois (não duplica, não reseta ainda — evita justamente o
      // caso que motivou essa regra: a Odysseia reenviando o lote inteiro
      // por timeout, o que antes resetava e perdia progresso, ex.: WhatsApp
      // já validado).
      expect(second.resultados.map((r) => r.kind)).toEqual(["discarded", "discarded"]);
    }
    // Contador "total geral" (pedido explícito 14/09) — 1 evento por item descartado.
    expect(descartes).toHaveLength(2);
    expect(descartes.every((d) => d.webhookId === "webhook-2")).toBe(true);
  });

  it("processa um lote maior que a concorrência padrão (10) mantendo o resultado na ordem certa (bug real: Odysseia, 495 leads, timeout — ver CONCORRENCIA_LOTE_PADRAO)", async () => {
    const { port, offersByKey } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = Array.from({ length: 25 }, (_, i) => ({
      cpf: String(i + 1).padStart(11, "0"),
      telefone: "85992100340",
      external_id: `lead-${i + 1}`,
    }));
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
      expect(outcome.resultados).toHaveLength(25);
      expect(outcome.resultados.every((r) => r.kind === "created")).toBe(true);
      // O offerId de cada resultado precisa corresponder ao external_id da MESMA
      // posição do item de entrada (concorrência não pode embaralhar a ordem).
      outcome.resultados.forEach((r, i) => {
        if (r.kind === "created") {
          const offer = [...offersByKey.values()].find((o) => o.id === r.offerId);
          expect(offer?.idempotencyKey).toBe(body[i].external_id);
        }
      });
    }
    expect(offersByKey.size).toBe(25);
  });

  it("respeita um limite de concorrência customizado (concorrenciaLote) passado explicitamente", async () => {
    const { port } = createFakeOffersPort([WEBHOOK_SIMPLES]);
    const body = Array.from({ length: 8 }, (_, i) => ({ cpf: String(i + 1).padStart(11, "0") }));
    const rawBody = JSON.stringify(body);

    const outcome = await handleWebhookRequest(port, {
      identificador: "odysseia",
      rawBody,
      body,
      headers: odysseiaHeaders(rawBody),
      toleranceSeconds: 300,
      concorrenciaLote: 2,
    });

    expect(outcome.kind).toBe("batch");
    if (outcome.kind === "batch") {
      expect(outcome.resultados).toHaveLength(8);
      expect(outcome.resultados.every((r) => r.kind === "created")).toBe(true);
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

describe("handleWebhookRequest — CPF repetido no mesmo webhook, mais de 24h depois (reset, nunca duplica)", () => {
  // A regra de descarte (14/09) depende de tempo real decorrido (Date.now()
  // — ver fake-offers-port.ts), não do "nowSeconds" que só serve pra
  // validar o timestamp da assinatura HMAC. Por isso esses testes usam
  // vi.useFakeTimers()/setSystemTime pra simular os "2 dias depois" de
  // verdade, e não só no cálculo da assinatura.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mesmo webhook + mesmo CPF de novo, mais de 24h depois: reseta a oferta existente em vez de criar outra ou descartar, mesmo com dados diferentes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { port, offersByCpf } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);

    const body1 = { cpf: "11111111111", telefone: "62999999999", nome: "João", external_id: "lead-1" };
    const rawBody1 = JSON.stringify(body1);
    const primeira = await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody: rawBody1, body: body1,
      headers: ofertasV1Headers(rawBody1), toleranceSeconds: 300, nowSeconds: NOW,
    });
    expect(primeira.kind).toBe("single");
    if (primeira.kind === "single") expect(primeira.resultado.kind).toBe("created");

    // 2 dias depois de verdade (172800s = 48h, > 24h da janela de descarte)
    vi.setSystemTime(new Date((NOW + 172800) * 1000));
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { port, offersByCpf } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);

    const body1 = { cpf: "111.111.111-11", telefone: "62999999999", external_id: "lead-1" };
    const rawBody1 = JSON.stringify(body1);
    await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody: rawBody1, body: body1,
      headers: ofertasV1Headers(rawBody1), toleranceSeconds: 300, nowSeconds: NOW,
    });

    vi.setSystemTime(new Date((NOW + 172800) * 1000));
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

  it("webhooks DIFERENTES com o mesmo CPF continuam gerando ofertas separadas (não reseta nem descarta entre fornecedores)", async () => {
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
    if (segunda.kind === "single") expect(segunda.resultado.kind).toBe("created"); // não é "reset" nem "discarded"
    expect(offersByCpf.size).toBe(2); // 2 ofertas separadas, uma por webhook
  });
});

describe("handleWebhookRequest — descarte por duplicidade em 24h (pedido explícito 14/09)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dentro de 24h: descarta sem tocar na oferta existente (nenhum progresso é perdido)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { port, offersByCpf, descartes } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);

    const body1 = { cpf: "11111111111", telefone: "62999999999", external_id: "lead-1" };
    const rawBody1 = JSON.stringify(body1);
    await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody: rawBody1, body: body1,
      headers: ofertasV1Headers(rawBody1), toleranceSeconds: 300, nowSeconds: NOW,
    });
    const ofertaOriginal = offersByCpf.get("webhook-1:11111111111");

    // 23h depois (82800s < 24h) — ainda dentro da janela.
    vi.setSystemTime(new Date((NOW + 82800) * 1000));
    const body2 = { cpf: "11111111111", telefone: "62988887777", external_id: "lead-2" };
    const rawBody2 = JSON.stringify(body2);
    const segunda = await handleWebhookRequest(port, {
      identificador: "origem-teste", rawBody: rawBody2, body: body2,
      headers: ofertasV1Headers(rawBody2, NOW + 82800), toleranceSeconds: 300, nowSeconds: NOW + 82800,
    });

    expect(segunda.kind).toBe("single");
    if (segunda.kind === "single") expect(segunda.resultado.kind).toBe("discarded");
    // A oferta existente não foi tocada em nada (mesmo objeto, mesmos dados).
    expect(offersByCpf.get("webhook-1:11111111111")).toEqual(ofertaOriginal);
    expect(descartes).toHaveLength(1);
    expect(descartes[0].webhookId).toBe("webhook-1");
  });

  it("um descarte NUNCA renova a janela de 24h — a contagem fica sendo a última vez que passou pelo funil de fato (confirmado explicitamente)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { port } = createFakeOffersPort([WEBHOOK_OFERTAS_V1]);

    const body = { cpf: "11111111111", telefone: "62999999999", external_id: "lead-1" };
    const rawBody = JSON.stringify(body);
    const params = {
      identificador: "origem-teste", rawBody, body,
      headers: ofertasV1Headers(rawBody), toleranceSeconds: 300, nowSeconds: NOW,
    };
    await handleWebhookRequest(port, params); // created, em NOW

    // 10h depois: descarte (dentro de 24h da criação em NOW).
    vi.setSystemTime(new Date((NOW + 36000) * 1000));
    const descarte1 = await handleWebhookRequest(port, params);
    expect(descarte1.kind === "single" && descarte1.resultado.kind).toBe("discarded");

    // Mais 15h depois (25h desde a criação original, mas só 15h desde o
    // descarte acima) — se o descarte tivesse renovado a janela, isso ainda
    // estaria "dentro de 24h" e descartaria de novo. Como NÃO renova, já
    // passou das 24h desde a última vez ACEITA (a criação em NOW) -> reseta.
    vi.setSystemTime(new Date((NOW + 36000 + 54000) * 1000));
    const terceira = await handleWebhookRequest(port, params);
    expect(terceira.kind === "single" && terceira.resultado.kind).toBe("reset");
  });
});

describe("extrairTelefoneOriginal — parceiro que manda listas em vez de campo simples (ex.: leilão de crédito, 02/09)", () => {
  it("usa cadastro.celulares com ranking 1 quando não tem campo 'telefone' (payload real da Karina, com os dados sensíveis trocados)", () => {
    const payload: RawWebhookPayload = {
      cpf: "00000000000",
      nome: "Nome Exemplo",
      cadastro: {
        celulares: [
          { ddd: 11, numero: "11933333333", ranking: 1, whatsapp: true },
          { ddd: 11, numero: "11911111111", ranking: 2, whatsapp: false },
          { ddd: 11, numero: "11922222222", ranking: 3, whatsapp: false },
        ],
      },
      telefones: ["11911111111", "11922222222"],
      whatsapps: ["11933333333"],
    };
    expect(extrairTelefoneOriginal(payload)).toBe("11933333333");
  });

  it("segue o RANKING, não a flag 'whatsapp' — pega o de ranking 1 mesmo que não seja o marcado como whatsapp:true", () => {
    const payload: RawWebhookPayload = {
      cpf: "00000000000",
      cadastro: {
        celulares: [
          { numero: "11900000001", ranking: 2, whatsapp: true },
          { numero: "11900000002", ranking: 1, whatsapp: false },
        ],
      },
    };
    expect(extrairTelefoneOriginal(payload)).toBe("11900000002");
  });

  it("prioriza o campo 'telefone' simples quando ele vier, mesmo com 'cadastro.celulares' também presente", () => {
    const payload: RawWebhookPayload = {
      cpf: "00000000000",
      telefone: "11900000000",
      cadastro: { celulares: [{ numero: "11933333333", ranking: 1, whatsapp: true }] },
    };
    expect(extrairTelefoneOriginal(payload)).toBe("11900000000");
  });

  it("cai pra 'whatsapps' quando 'cadastro.celulares' não vem nesse payload (formato mais simples do mesmo parceiro)", () => {
    const payload: RawWebhookPayload = { cpf: "00000000000", whatsapps: ["11933333333"] };
    expect(extrairTelefoneOriginal(payload)).toBe("11933333333");
  });

  it("cai pra 'whatsapps' quando 'cadastro.celulares' vem mas nenhum item tem ranking 1", () => {
    const payload: RawWebhookPayload = {
      cpf: "00000000000",
      cadastro: { celulares: [{ numero: "11900000002", ranking: 2, whatsapp: false }] },
      whatsapps: ["11933333333"],
    };
    expect(extrairTelefoneOriginal(payload)).toBe("11933333333");
  });

  it("devolve null quando não tem nenhuma das 3 fontes (parceiro genuinamente não mandou telefone nenhum)", () => {
    expect(extrairTelefoneOriginal({ cpf: "00000000000" })).toBeNull();
  });

  it("devolve null quando 'whatsapps' existe mas é uma lista vazia, e não tem celulares nem telefone", () => {
    expect(extrairTelefoneOriginal({ cpf: "00000000000", whatsapps: [] })).toBeNull();
  });

  it("não usa 'telefones' (lista de números não confirmados) em nenhum ponto da prioridade", () => {
    const payload: RawWebhookPayload = { cpf: "00000000000", telefones: ["11911111111"] };
    expect(extrairTelefoneOriginal(payload)).toBeNull();
  });
});

describe("extrairBancoAutorizado — mesmo parceiro de leilão, o banco vem em 'leilao.bancoAprovado'", () => {
  it("usa 'leilao.bancoAprovado' quando não tem campo 'banco_autorizado' simples (payload real da Karina)", () => {
    const payload: RawWebhookPayload = {
      cpf: "00000000000",
      leilao: { bancoAprovado: "Presenca" },
    };
    expect(extrairBancoAutorizado(payload)).toBe("Presenca");
  });

  it("prioriza 'banco_autorizado' simples quando ele vier, mesmo com 'leilao.bancoAprovado' também presente", () => {
    const payload: RawWebhookPayload = {
      cpf: "00000000000",
      banco_autorizado: "C6",
      leilao: { bancoAprovado: "Outro Banco" },
    };
    expect(extrairBancoAutorizado(payload)).toBe("C6");
  });

  it("devolve null quando não tem nenhuma das 2 fontes", () => {
    expect(extrairBancoAutorizado({ cpf: "00000000000" })).toBeNull();
  });

  it("devolve null quando 'leilao' vem mas sem o campo 'bancoAprovado'", () => {
    expect(extrairBancoAutorizado({ cpf: "00000000000", leilao: {} })).toBeNull();
  });
});
