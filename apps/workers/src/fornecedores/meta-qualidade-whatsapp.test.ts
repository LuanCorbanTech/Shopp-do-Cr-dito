import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buscarNumerosWhatsappMeta, MetaQualidadeError } from "./meta-qualidade-whatsapp";

function respostaFetch(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("buscarNumerosWhatsappMeta", () => {
  const fetchOriginal = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = fetchOriginal;
    vi.restoreAllMocks();
  });

  it("monta a URL com a versão normalizada e o header Authorization correto", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(respostaFetch(200, { data: [] }));

    await buscarNumerosWhatsappMeta({ wabaId: "123", tokenAcesso: "tok-abc", versaoGraphApi: "21.0" });

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe(
      "https://graph.facebook.com/v21.0/123/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status"
    );
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-abc" });
  });

  it("aceita a versão já vindo com 'v' na frente", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(respostaFetch(200, { data: [] }));

    await buscarNumerosWhatsappMeta({ wabaId: "123", tokenAcesso: "tok", versaoGraphApi: "v21.0" });

    const [url] = mock.mock.calls[0];
    expect(url).toContain("/v21.0/");
  });

  it("mapeia os campos da Meta pro formato interno", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(
      respostaFetch(200, {
        data: [
          {
            id: "pn-1",
            display_phone_number: "+55 11 90000-0000",
            verified_name: "Loja 1",
            quality_rating: "GREEN",
            messaging_limit_tier: "TIER_10K",
            status: "CONNECTED",
          },
        ],
      })
    );

    const resultado = await buscarNumerosWhatsappMeta({ wabaId: "123", tokenAcesso: "tok", versaoGraphApi: "21.0" });

    expect(resultado).toEqual([
      {
        phoneNumberId: "pn-1",
        displayPhoneNumber: "+55 11 90000-0000",
        verifiedName: "Loja 1",
        qualityRating: "GREEN",
        messagingLimitTier: "TIER_10K",
        status: "CONNECTED",
      },
    ]);
  });

  it("usa UNKNOWN quando quality_rating vem vazio/ausente", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(respostaFetch(200, { data: [{ id: "pn-2", display_phone_number: "+55 11 91111-1111" }] }));

    const resultado = await buscarNumerosWhatsappMeta({ wabaId: "123", tokenAcesso: "tok", versaoGraphApi: "21.0" });

    expect(resultado[0].qualityRating).toBe("UNKNOWN");
    expect(resultado[0].verifiedName).toBeNull();
    expect(resultado[0].messagingLimitTier).toBeNull();
    expect(resultado[0].status).toBeNull();
  });

  it("devolve lista vazia quando 'data' não vem no corpo", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(respostaFetch(200, {}));

    const resultado = await buscarNumerosWhatsappMeta({ wabaId: "123", tokenAcesso: "tok", versaoGraphApi: "21.0" });

    expect(resultado).toEqual([]);
  });

  it("lança MetaQualidadeError com a mensagem da Meta quando a resposta não é 2xx", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(
      respostaFetch(401, { error: { message: "Error validating access token", type: "OAuthException", code: 190 } })
    );

    await expect(buscarNumerosWhatsappMeta({ wabaId: "123", tokenAcesso: "tok-expirado", versaoGraphApi: "21.0" })).rejects.toMatchObject(
      { message: "Error validating access token", httpStatus: 401 }
    );
  });

  it("lança MetaQualidadeError (sem status) em falha de rede", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockRejectedValueOnce(new Error("network down"));

    await expect(buscarNumerosWhatsappMeta({ wabaId: "123", tokenAcesso: "tok", versaoGraphApi: "21.0" })).rejects.toBeInstanceOf(
      MetaQualidadeError
    );
  });

  it("usa WABA_ID inválido (400) e propaga a mensagem de erro da Meta", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(
      respostaFetch(400, { error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 } })
    );

    await expect(buscarNumerosWhatsappMeta({ wabaId: "id-invalido", tokenAcesso: "tok", versaoGraphApi: "21.0" })).rejects.toMatchObject(
      { httpStatus: 400 }
    );
  });
});
