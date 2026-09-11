import { describe, expect, it, vi } from "vitest";
import {
  runQualidadeWhatsappWorkerOnce,
  type MetaQualidadeService,
  type NumeroWhatsappPiorou,
  type QualidadeWhatsappPort,
  type WabaParaConsultar,
} from "./worker10-qualidade-whatsapp";
import type { MetaPhoneNumberResult } from "../fornecedores/meta-qualidade-whatsapp";

function criarWaba(overrides: Partial<WabaParaConsultar> = {}): WabaParaConsultar {
  return {
    id: "waba-1",
    wabaId: "1234567890",
    bmContaId: "bm-1",
    bmNome: "VieiraCred",
    tokenAcesso: "tok-1",
    ...overrides,
  };
}

function criarPortFake(overrides: Partial<QualidadeWhatsappPort> = {}): QualidadeWhatsappPort {
  return {
    wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([]),
    registrarConsultaWabaSucesso: vi.fn().mockResolvedValue({ pioraram: [] }),
    registrarConsultaWabaErro: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runQualidadeWhatsappWorkerOnce", () => {
  it("não faz nada quando desativado no painel", async () => {
    const port = criarPortFake();
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn() };

    const resultado = await runQualidadeWhatsappWorkerOnce({ ativo: false, port, metaService });

    expect(resultado).toEqual({ consultadas: 0, erros: 0, alertasEnviados: 0 });
    expect(port.wabasQualidadeParaConsultar).not.toHaveBeenCalled();
  });

  it("não faz nada quando não há WABAs pra consultar nesse ciclo", async () => {
    const port = criarPortFake({ wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([]) });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn() };

    const resultado = await runQualidadeWhatsappWorkerOnce({ ativo: true, port, metaService });

    expect(resultado).toEqual({ consultadas: 0, erros: 0, alertasEnviados: 0 });
    expect(metaService.buscarNumeros).not.toHaveBeenCalled();
  });

  it("consulta cada WABA na Meta e registra sucesso, sem alertas quando ninguém piorou", async () => {
    const waba = criarWaba();
    const numeros: MetaPhoneNumberResult[] = [
      {
        phoneNumberId: "pn-1",
        displayPhoneNumber: "+55 11 90000-0000",
        verifiedName: "Loja 1",
        qualityRating: "GREEN",
        messagingLimitTier: "TIER_1K",
        status: "CONNECTED",
      },
    ];
    const port = criarPortFake({
      wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([waba]),
      registrarConsultaWabaSucesso: vi.fn().mockResolvedValue({ pioraram: [] }),
    });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn().mockResolvedValue(numeros) };

    const resultado = await runQualidadeWhatsappWorkerOnce({ ativo: true, port, metaService, webhookAlertaUrl: "https://x.com/alerta" });

    expect(metaService.buscarNumeros).toHaveBeenCalledWith({ wabaId: waba.wabaId, tokenAcesso: waba.tokenAcesso, versaoGraphApi: "v21.0" });
    expect(port.registrarConsultaWabaSucesso).toHaveBeenCalledWith({ wabaContaId: waba.id, numeros });
    expect(resultado).toEqual({ consultadas: 1, erros: 0, alertasEnviados: 0 });
  });

  it("usa a versão da Graph API configurada no painel", async () => {
    const waba = criarWaba();
    const port = criarPortFake({ wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([waba]) });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn().mockResolvedValue([]) };

    await runQualidadeWhatsappWorkerOnce({ ativo: true, port, metaService, versaoGraphApi: "v23.0" });

    expect(metaService.buscarNumeros).toHaveBeenCalledWith(expect.objectContaining({ versaoGraphApi: "v23.0" }));
  });

  it("dispara 1 webhook de alerta por número que piorou, quando há URL configurada", async () => {
    const waba = criarWaba();
    const pioras: NumeroWhatsappPiorou[] = [
      {
        numeroId: "num-1",
        displayPhoneNumber: "+55 11 90000-0000",
        wabaId: waba.wabaId,
        bmNome: waba.bmNome,
        motivo: "qualidade caiu de GREEN para RED",
        qualityRatingAnterior: "GREEN",
        qualityRatingAtual: "RED",
      },
      {
        numeroId: "num-2",
        displayPhoneNumber: "+55 11 98888-8888",
        wabaId: waba.wabaId,
        bmNome: waba.bmNome,
        motivo: "status mudou para FLAGGED",
        qualityRatingAnterior: "GREEN",
        qualityRatingAtual: "GREEN",
      },
    ];
    const port = criarPortFake({
      wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([waba]),
      registrarConsultaWabaSucesso: vi.fn().mockResolvedValue({ pioraram: pioras }),
    });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn().mockResolvedValue([]) };
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const resultado = await runQualidadeWhatsappWorkerOnce({
      ativo: true,
      port,
      metaService,
      webhookAlertaUrl: "https://exemplo.com/alerta",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(resultado.alertasEnviados).toBe(2);
    const [, init] = fetchImpl.mock.calls[0];
    const corpo = JSON.parse((init as RequestInit).body as string);
    expect(corpo).toMatchObject({ tipo: "qualidade_whatsapp_piorou", numeroId: "num-1", motivo: "qualidade caiu de GREEN para RED" });
  });

  it("não dispara webhook quando não há URL de alerta configurada, mesmo com piora", async () => {
    const waba = criarWaba();
    const port = criarPortFake({
      wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([waba]),
      registrarConsultaWabaSucesso: vi.fn().mockResolvedValue({
        pioraram: [
          {
            numeroId: "num-1",
            displayPhoneNumber: "+55 11 90000-0000",
            wabaId: waba.wabaId,
            bmNome: waba.bmNome,
            motivo: "qualidade caiu de GREEN para RED",
            qualityRatingAnterior: "GREEN",
            qualityRatingAtual: "RED",
          },
        ],
      }),
    });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn().mockResolvedValue([]) };
    const fetchImpl = vi.fn();

    const resultado = await runQualidadeWhatsappWorkerOnce({
      ativo: true,
      port,
      metaService,
      webhookAlertaUrl: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resultado.alertasEnviados).toBe(0);
  });

  it("uma falha ao enviar o alerta não é contada, mas também não derruba o ciclo", async () => {
    const waba = criarWaba();
    const port = criarPortFake({
      wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([waba]),
      registrarConsultaWabaSucesso: vi.fn().mockResolvedValue({
        pioraram: [
          {
            numeroId: "num-1",
            displayPhoneNumber: "+55 11 90000-0000",
            wabaId: waba.wabaId,
            bmNome: waba.bmNome,
            motivo: "qualidade caiu de GREEN para RED",
            qualityRatingAnterior: "GREEN",
            qualityRatingAtual: "RED",
          },
        ],
      }),
    });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn().mockResolvedValue([]) };
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));

    const resultado = await runQualidadeWhatsappWorkerOnce({
      ativo: true,
      port,
      metaService,
      webhookAlertaUrl: "https://exemplo.com/alerta",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(resultado).toEqual({ consultadas: 1, erros: 0, alertasEnviados: 0 });
  });

  it("uma WABA com erro (token expirado, por ex.) não impede as próximas de serem consultadas", async () => {
    const wabaComErro = criarWaba({ id: "waba-erro", wabaId: "111", bmNome: "BM com token vencido" });
    const wabaOk = criarWaba({ id: "waba-ok", wabaId: "222" });
    const port = criarPortFake({
      wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([wabaComErro, wabaOk]),
      registrarConsultaWabaSucesso: vi.fn().mockResolvedValue({ pioraram: [] }),
    });
    const metaService: MetaQualidadeService = {
      buscarNumeros: vi
        .fn()
        .mockRejectedValueOnce(new Error("Error validating access token"))
        .mockResolvedValueOnce([]),
    };

    const resultado = await runQualidadeWhatsappWorkerOnce({ ativo: true, port, metaService });

    expect(port.registrarConsultaWabaErro).toHaveBeenCalledWith("waba-erro", "Error validating access token");
    expect(port.registrarConsultaWabaSucesso).toHaveBeenCalledTimes(1);
    expect(resultado).toEqual({ consultadas: 1, erros: 1, alertasEnviados: 0 });
  });

  it("respeita o batchSize configurado ao pedir WABAs pra consultar", async () => {
    const port = criarPortFake({ wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([]) });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn() };

    await runQualidadeWhatsappWorkerOnce({ ativo: true, batchSize: 25, port, metaService });

    expect(port.wabasQualidadeParaConsultar).toHaveBeenCalledWith(25);
  });
});
