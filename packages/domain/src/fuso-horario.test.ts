import { describe, expect, it } from "vitest";
import { inicioDoDiaEmBrasilia } from "./fuso-horario";

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
