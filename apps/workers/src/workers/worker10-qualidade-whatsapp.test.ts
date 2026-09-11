import { describe, expect, it, vi } from "vitest";
import {
  runQualidadeWhatsappWorkerOnce,
  type MetaQualidadeService,
  type QualidadeWhatsappPort,
  type WabaParaConsultar,
} from "./worker10-qualidade-whatsapp";
import type { MetaPhoneNumberResult } from "../fornecedores/meta-qualidade-whatsapp";

function criarWaba(overrides: Partial<WabaParaConsultar> = {}): WabaParaConsultar {
  return {
    id: "waba-1",
    wabaId: "1234567890",
    bmContaId: "bm-1",
    bmNome: "Loja Centro",
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

    expect(resultado).toEqual({ consultadas: 0, erros: 0 });
    expect(port.wabasQualidadeParaConsultar).not.toHaveBeenCalled();
  });

  it("não faz nada quando não há WABAs pra consultar nesse ciclo", async () => {
    const port = criarPortFake({ wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([]) });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn() };

    const resultado = await runQualidadeWhatsappWorkerOnce({ ativo: true, port, metaService });

    expect(resultado).toEqual({ consultadas: 0, erros: 0 });
    expect(metaService.buscarNumeros).not.toHaveBeenCalled();
  });

  it("pede TODAS as WABAs pra consultar, sem lote/limite (11/09 — antes era um batchSize)", async () => {
    const port = criarPortFake({ wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([]) });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn() };

    await runQualidadeWhatsappWorkerOnce({ ativo: true, port, metaService });

    expect(port.wabasQualidadeParaConsultar).toHaveBeenCalledWith();
  });

  it("consulta cada WABA na Meta e registra sucesso", async () => {
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

    const resultado = await runQualidadeWhatsappWorkerOnce({ ativo: true, port, metaService });

    expect(metaService.buscarNumeros).toHaveBeenCalledWith({ wabaId: waba.wabaId, tokenAcesso: waba.tokenAcesso, versaoGraphApi: "v21.0" });
    expect(port.registrarConsultaWabaSucesso).toHaveBeenCalledWith({ wabaContaId: waba.id, numeros });
    expect(resultado).toEqual({ consultadas: 1, erros: 0 });
  });

  it("usa a versão da Graph API configurada no painel", async () => {
    const waba = criarWaba();
    const port = criarPortFake({ wabasQualidadeParaConsultar: vi.fn().mockResolvedValue([waba]) });
    const metaService: MetaQualidadeService = { buscarNumeros: vi.fn().mockResolvedValue([]) };

    await runQualidadeWhatsappWorkerOnce({ ativo: true, port, metaService, versaoGraphApi: "v23.0" });

    expect(metaService.buscarNumeros).toHaveBeenCalledWith(expect.objectContaining({ versaoGraphApi: "v23.0" }));
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
    expect(resultado).toEqual({ consultadas: 1, erros: 1 });
  });
});
