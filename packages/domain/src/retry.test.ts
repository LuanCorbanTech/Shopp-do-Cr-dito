import { describe, expect, it } from "vitest";
import {
  backoffSecondsForAttempt,
  hasExceededMaxAttempts,
  nextAttemptDate,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
} from "./retry";

describe("backoffSecondsForAttempt", () => {
  it("segue o schedule configurado", () => {
    expect(backoffSecondsForAttempt(1)).toBe(DEFAULT_BACKOFF_SCHEDULE_SECONDS[0]);
    expect(backoffSecondsForAttempt(2)).toBe(DEFAULT_BACKOFF_SCHEDULE_SECONDS[1]);
  });

  it("usa o último valor do schedule para tentativas além do tamanho da lista", () => {
    const schedule = [10, 20, 30];
    expect(backoffSecondsForAttempt(10, schedule)).toBe(30);
  });

  it("nunca é negativo mesmo com tentativa 0", () => {
    expect(backoffSecondsForAttempt(0)).toBe(DEFAULT_BACKOFF_SCHEDULE_SECONDS[0]);
  });
});

describe("nextAttemptDate", () => {
  it("soma os segundos de backoff ao horário atual", () => {
    const now = new Date("2026-08-14T12:00:00Z");
    const result = nextAttemptDate(1, now, [30]);
    expect(result.toISOString()).toBe("2026-08-14T12:00:30.000Z");
  });
});

describe("hasExceededMaxAttempts", () => {
  it("nunca é infinito — respeita o máximo configurado", () => {
    expect(hasExceededMaxAttempts(5, 5)).toBe(true);
    expect(hasExceededMaxAttempts(4, 5)).toBe(false);
  });
});
