import { describe, expect, it, vi } from "vitest";
import {
  montarRelatorioQualidadeWhatsappBody,
  runRelatorioQualidadeWhatsappWorkerOnce,
  type NumeroQualidadeParaRelatorio,
} from "./worker11-relatorio-qualidade-whatsapp";

const NUMEROS_EXEMPLO: NumeroQualidadeParaRelatorio[] = [
  { phoneNumberId: "pn-1", displayPhoneNumber: "+55 11 90000-0000", qualityRating: "GREEN", wabaId: "111", bmNome: "Loja Centro" },
  { phoneNumberId: "pn-2", displayPhoneNumber: "+55 11 91111-1111", qualityRating: "YELLOW", wabaId: "111", bmNome: "Loja Centro" },
  { phoneNumberId: "pn-3", displayPhoneNumber: "+55 11 92222-2222", qualityRating: "RED", wabaId: "222", bmNome: "Loja Bairro" },
  { phoneNumberId: "pn-4", displayPhoneNumber: "+55 11 93333-3333", qualityRating: "UNKNOWN", wabaId: "222", bmNome: "Loja Bairro" },
];

describe("montarRelatorioQualidadeWhatsappBody", () => {
  it("traduz GREEN/YELLOW/RED/UNKNOWN pra alta/media/baixa/desconhecido e leva os dois identificadores", () => {
    const body = montarRelatorioQualidadeWhatsappBody(NUMEROS_EXEMPLO);
    expect(body.total_numeros).toBe(4);
    expect(body.numeros).toEqual([
      { phone_number_id: "pn-1", numero: "+55 11 90000-0000", bm: "Loja Centro", waba_id: "111", qualidade: "alta" },
      { phone_number_id: "pn-2", numero: "+55 11 91111-1111", bm: "Loja Centro", waba_id: "111", qualidade: "media" },
      { phone_number_id: "pn-3", numero: "+55 11 92222-2222", bm: "Loja Bairro", waba_id: "222", qualidade: "baixa" },
      { phone_number_id: "pn-4", numero: "+55 11 93333-3333", bm: "Loja Bairro", waba_id: "222", qualidade: "desconhecido" },
    ]);
  });

  it("qualidade não reconhecida também vira 'desconhecido' (nunca quebra o relatório)", () => {
    const body = montarRelatorioQualidadeWhatsappBody([
      { phoneNumberId: "pn-9", displayPhoneNumber: "+55 11 90000-0000", qualityRating: "ALGO_NOVO", wabaId: "1", bmNome: "X" },
    ]);
    expect(body.numeros[0].qualidade).toBe("desconhecido");
  });

  it("lista vazia gera total_numeros 0 e numeros []", () => {
    const body = montarRelatorioQualidadeWhatsappBody([]);
    expect(body.total_numeros).toBe(0);
    expect(body.numeros).toEqual([]);
  });
});

describe("runRelatorioQualidadeWhatsappWorkerOnce", () => {
  it("não envia nada quando desativado", async () => {
    const fetchImpl = vi.fn();
    const resultado = await runRelatorioQualidadeWhatsappWorkerOnce({
      ativo: false,
      webhookUrl: "https://exemplo.com/relatorio-qualidade",
      numeros: NUMEROS_EXEMPLO,
      fetchImpl,
    });
    expect(resultado).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("não envia nada quando está ativo mas sem webhook cadastrado", async () => {
    const fetchImpl = vi.fn();
    const resultado = await runRelatorioQualidadeWhatsappWorkerOnce({
      ativo: true,
      webhookUrl: null,
      numeros: NUMEROS_EXEMPLO,
      fetchImpl,
    });
    expect(resultado).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("envia 1 POST com todos os números e a qualidade já traduzida, quando ativo e com webhook", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const resultado = await runRelatorioQualidadeWhatsappWorkerOnce({
      ativo: true,
      webhookUrl: "https://exemplo.com/relatorio-qualidade",
      numeros: NUMEROS_EXEMPLO,
      fetchImpl,
    });

    expect(resultado).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://exemplo.com/relatorio-qualidade");
    // Pedido explícito do usuário (11/09): sem token cadastrado, o POST sai
    // sem NENHUM header custom — nem Content-Type, nem Authorization.
    expect((init as RequestInit).headers).toEqual({});
    const corpo = JSON.parse((init as RequestInit).body as string);
    expect(corpo.total_numeros).toBe(4);
    expect(corpo.numeros).toHaveLength(4);
  });

  it("devolve 0 (sem lançar) quando o webhook responde com erro", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const resultado = await runRelatorioQualidadeWhatsappWorkerOnce({
      ativo: true,
      webhookUrl: "https://exemplo.com/relatorio-qualidade",
      numeros: NUMEROS_EXEMPLO,
      fetchImpl,
    });
    expect(resultado).toBe(0);
  });

  it("devolve 0 (sem lançar) quando o fetch falha (rede)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));
    const resultado = await runRelatorioQualidadeWhatsappWorkerOnce({
      ativo: true,
      webhookUrl: "https://exemplo.com/relatorio-qualidade",
      numeros: NUMEROS_EXEMPLO,
      fetchImpl,
    });
    expect(resultado).toBe(0);
  });

  it("inclui o header Authorization: Bearer quando um token está configurado", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await runRelatorioQualidadeWhatsappWorkerOnce({
      ativo: true,
      webhookUrl: "https://exemplo.com/relatorio-qualidade",
      webhookAuthToken: "token-de-teste-fake-123",
      numeros: NUMEROS_EXEMPLO,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    // Só o header de autenticação — sem Content-Type (pedido explícito do usuário).
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer token-de-teste-fake-123",
    });
  });

  it("não inclui nenhum header quando nenhum token está configurado", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await runRelatorioQualidadeWhatsappWorkerOnce({
      ativo: true,
      webhookUrl: "https://exemplo.com/relatorio-qualidade",
      webhookAuthToken: null,
      numeros: NUMEROS_EXEMPLO,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({});
  });
});
