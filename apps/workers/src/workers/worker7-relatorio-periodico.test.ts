import { describe, expect, it, vi } from "vitest";
import { runRelatorioPeriodicoWorkerOnce, montarRelatorioPeriodicoBody } from "./worker7-relatorio-periodico";

const KPIS_EXEMPLO = {
  totalRecebidas: 100,
  aguardandoProcessamento: 10,
  limiteValidado: 80,
  whatsappValidado: 60,
  aguardandoConsultaDisparo: 5,
  disparoConsultado: 50,
  disparoEnviado: 40,
  disparoRespondido: 20,
};

describe("montarRelatorioPeriodicoBody", () => {
  it("monta o corpo com os 9 campos exatos pedidos, calculando a taxa de resposta", () => {
    const body = montarRelatorioPeriodicoBody(KPIS_EXEMPLO);
    expect(body).toEqual({
      "Total de ofertas recebidas": 100,
      "Aguardando processamento": 10,
      "Com Lemit validado": 80,
      "Com Whatsapp validado": 60,
      "Aguardando consulta do disparo": 5,
      "Com disparo consultado": 50,
      "Disparo enviado": 40,
      "Disparo respondido": 20,
      "Taxa de resposta": 0.5,
    });
  });

  it("taxa de resposta é 0 (não NaN) quando ainda não houve nenhum disparo enviado", () => {
    const body = montarRelatorioPeriodicoBody({ ...KPIS_EXEMPLO, disparoEnviado: 0, disparoRespondido: 0 });
    expect(body["Taxa de resposta"]).toBe(0);
  });
});

describe("runRelatorioPeriodicoWorkerOnce", () => {
  it("não envia nada quando a integração está desativada", async () => {
    const fetchImpl = vi.fn();
    const resultado = await runRelatorioPeriodicoWorkerOnce({
      ativo: false,
      endpointUrl: "https://exemplo.com/relatorio",
      kpis: KPIS_EXEMPLO,
      fetchImpl,
    });
    expect(resultado).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("não envia nada quando está ativo mas sem endpoint cadastrado", async () => {
    const fetchImpl = vi.fn();
    const resultado = await runRelatorioPeriodicoWorkerOnce({
      ativo: true,
      endpointUrl: null,
      kpis: KPIS_EXEMPLO,
      fetchImpl,
    });
    expect(resultado).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("faz POST com só o header Content-Type e o corpo com os 9 campos", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const resultado = await runRelatorioPeriodicoWorkerOnce({
      ativo: true,
      endpointUrl: "https://exemplo.com/relatorio",
      kpis: KPIS_EXEMPLO,
      fetchImpl,
    });

    expect(resultado).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://exemplo.com/relatorio");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual(montarRelatorioPeriodicoBody(KPIS_EXEMPLO));
  });

  it("retorna 0 quando o endpoint responde com erro (sem lançar exceção)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const resultado = await runRelatorioPeriodicoWorkerOnce({
      ativo: true,
      endpointUrl: "https://exemplo.com/relatorio",
      kpis: KPIS_EXEMPLO,
      fetchImpl,
    });
    expect(resultado).toBe(0);
  });

  it("retorna 0 quando o fetch lança exceção (ex.: endpoint fora do ar)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
    const resultado = await runRelatorioPeriodicoWorkerOnce({
      ativo: true,
      endpointUrl: "https://exemplo.com/relatorio",
      kpis: KPIS_EXEMPLO,
      fetchImpl,
    });
    expect(resultado).toBe(0);
  });
});
