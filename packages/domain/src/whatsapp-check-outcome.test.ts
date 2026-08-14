import { describe, expect, it } from "vitest";
import { decideWhatsappCheckFailureOutcome } from "./whatsapp-check-outcome";

describe("decideWhatsappCheckFailureOutcome", () => {
  it("agenda retry com backoff quando ainda não esgotou as tentativas", () => {
    const now = new Date("2026-08-14T12:00:00Z");
    const result = decideWhatsappCheckFailureOutcome({
      tentativaAtual: 0,
      backoffSchedule: [30, 60],
      maxTentativas: 5,
      now,
    });
    expect(result.tentativa).toBe(1);
    expect(result.cancelar).toBe(false);
    expect(result.proximaTentativaEm?.toISOString()).toBe("2026-08-14T12:00:30.000Z");
  });

  it("cancela e não agenda retry ao esgotar as tentativas", () => {
    const result = decideWhatsappCheckFailureOutcome({
      tentativaAtual: 4,
      maxTentativas: 5,
    });
    expect(result.tentativa).toBe(5);
    expect(result.cancelar).toBe(true);
    expect(result.proximaTentativaEm).toBeNull();
  });

  it("usa os valores default de retry.ts quando nenhuma configuração é passada", () => {
    const result = decideWhatsappCheckFailureOutcome({ tentativaAtual: 0 });
    expect(result.tentativa).toBe(1);
    expect(result.cancelar).toBe(false);
    expect(result.proximaTentativaEm).not.toBeNull();
  });
});
