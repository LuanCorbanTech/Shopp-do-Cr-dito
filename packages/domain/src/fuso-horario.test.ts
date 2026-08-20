import { describe, expect, it } from "vitest";
import { inicioDoDiaEmBrasilia, estaDentroDaJanelaDeEnvio } from "./fuso-horario";

describe("inicioDoDiaEmBrasilia", () => {
  it("retorna meia-noite de Brasília (03:00 UTC) para um horário à tarde em Brasília", () => {
    // 2026-08-20T14:32:07Z = 11:32:07 em Brasília (UTC-3), ainda dia 20 lá.
    const resultado = inicioDoDiaEmBrasilia(new Date("2026-08-20T14:32:07.000Z"));
    expect(resultado.toISOString()).toBe("2026-08-20T03:00:00.000Z");
  });

  it("já considera o dia seguinte quando ainda é UTC do dia anterior mas já virou o dia em Brasília", () => {
    // Não existe virada assim (Brasília está sempre atrás de UTC), mas o caso
    // inverso importa: perto da meia-noite UTC ainda é o dia anterior em Brasília.
    // 2026-08-21T01:00:00Z = 2026-08-20T22:00:00 em Brasília — ainda dia 20 lá.
    const resultado = inicioDoDiaEmBrasilia(new Date("2026-08-21T01:00:00.000Z"));
    expect(resultado.toISOString()).toBe("2026-08-20T03:00:00.000Z");
  });

  it("vira o dia certo logo após a meia-noite de Brasília", () => {
    // 2026-08-21T03:00:01Z = 2026-08-21T00:00:01 em Brasília — já é dia 21 lá.
    const resultado = inicioDoDiaEmBrasilia(new Date("2026-08-21T03:00:01.000Z"));
    expect(resultado.toISOString()).toBe("2026-08-21T03:00:00.000Z");
  });
});

describe("estaDentroDaJanelaDeEnvio", () => {
  it("sem janela configurada (horaInicio ou horaFim ausente), nunca bloqueia", () => {
    const agora = new Date("2026-08-20T06:00:00.000Z"); // 03:00 em Brasília — de madrugada
    expect(estaDentroDaJanelaDeEnvio(agora, null, null)).toBe(true);
    expect(estaDentroDaJanelaDeEnvio(agora, "08:00", null)).toBe(true);
    expect(estaDentroDaJanelaDeEnvio(agora, null, "20:00")).toBe(true);
  });

  it("janela normal (não cruza meia-noite): dentro do intervalo", () => {
    // 2026-08-20T15:00:00Z = 12:00 em Brasília.
    const agora = new Date("2026-08-20T15:00:00.000Z");
    expect(estaDentroDaJanelaDeEnvio(agora, "08:00", "20:00")).toBe(true);
  });

  it("janela normal: de madrugada fica de fora (o caso que o usuário pediu para evitar)", () => {
    // 2026-08-20T06:00:00Z = 03:00 em Brasília — de madrugada.
    const agora = new Date("2026-08-20T06:00:00.000Z");
    expect(estaDentroDaJanelaDeEnvio(agora, "08:00", "20:00")).toBe(false);
  });

  it("janela normal: nos limites exatos (início e fim são inclusivos)", () => {
    // 2026-08-20T11:00:00Z = 08:00 em Brasília (início exato).
    expect(estaDentroDaJanelaDeEnvio(new Date("2026-08-20T11:00:00.000Z"), "08:00", "20:00")).toBe(true);
    // 2026-08-20T23:00:00Z = 20:00 em Brasília (fim exato).
    expect(estaDentroDaJanelaDeEnvio(new Date("2026-08-20T23:00:00.000Z"), "08:00", "20:00")).toBe(true);
  });

  it("janela que cruza a meia-noite (ex.: 22:00 às 06:00): dentro tanto à noite quanto de madrugada", () => {
    // 2026-08-20T23:30:00Z = 20:30 em Brasília — antes da janela cruzada começar (22h).
    expect(estaDentroDaJanelaDeEnvio(new Date("2026-08-20T23:30:00.000Z"), "22:00", "06:00")).toBe(false);
    // 2026-08-21T01:30:00Z = 22:30 em Brasília — dentro (depois das 22h).
    expect(estaDentroDaJanelaDeEnvio(new Date("2026-08-21T01:30:00.000Z"), "22:00", "06:00")).toBe(true);
    // 2026-08-21T07:30:00Z = 04:30 em Brasília — dentro (antes das 6h).
    expect(estaDentroDaJanelaDeEnvio(new Date("2026-08-21T07:30:00.000Z"), "22:00", "06:00")).toBe(true);
    // 2026-08-21T12:00:00Z = 09:00 em Brasília — fora (depois das 6h, antes das 22h).
    expect(estaDentroDaJanelaDeEnvio(new Date("2026-08-21T12:00:00.000Z"), "22:00", "06:00")).toBe(false);
  });

  it("configuração inválida não bloqueia o envio", () => {
    const agora = new Date("2026-08-20T06:00:00.000Z");
    expect(estaDentroDaJanelaDeEnvio(agora, "não é hora", "20:00")).toBe(true);
  });
});
