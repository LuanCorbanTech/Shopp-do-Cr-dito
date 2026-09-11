import { describe, expect, it } from "vitest";
import { mapWithConcurrencyLimit } from "./concurrency";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrencyLimit", () => {
  it("processa todos os itens e devolve o resultado na MESMA ORDEM da entrada, mesmo quando terminam fora de ordem", async () => {
    const itens = [30, 5, 20, 1, 10];
    const resultado = await mapWithConcurrencyLimit(itens, 3, async (item) => {
      await sleep(item); // itens "maiores" demoram mais -> tendem a terminar depois
      return item * 2;
    });

    expect(resultado).toEqual([60, 10, 40, 2, 20]);
  });

  it("nunca roda mais que `limit` execuções ao mesmo tempo", async () => {
    let emAndamento = 0;
    let picoDeConcorrencia = 0;
    const itens = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrencyLimit(itens, 4, async (item) => {
      emAndamento += 1;
      picoDeConcorrencia = Math.max(picoDeConcorrencia, emAndamento);
      await sleep(5);
      emAndamento -= 1;
      return item;
    });

    expect(picoDeConcorrencia).toBeLessThanOrEqual(4);
    expect(picoDeConcorrencia).toBeGreaterThan(1); // confirma que realmente rodou em paralelo, não em série
  });

  it("processa cada item exatamente uma vez", async () => {
    const itens = Array.from({ length: 50 }, (_, i) => i);
    const processados: number[] = [];

    await mapWithConcurrencyLimit(itens, 7, async (item) => {
      processados.push(item);
      return item;
    });

    expect(processados).toHaveLength(50);
    expect(new Set(processados).size).toBe(50);
  });

  it("funciona com limit maior que a quantidade de itens", async () => {
    const resultado = await mapWithConcurrencyLimit([1, 2, 3], 100, async (item) => item + 1);
    expect(resultado).toEqual([2, 3, 4]);
  });

  it("funciona com lista vazia", async () => {
    const resultado = await mapWithConcurrencyLimit([], 10, async (item) => item);
    expect(resultado).toEqual([]);
  });

  it("propaga erro de um item sem travar (Promise.all rejeita se qualquer worker rejeitar)", async () => {
    const itens = [1, 2, 3];
    await expect(
      mapWithConcurrencyLimit(itens, 2, async (item) => {
        if (item === 2) throw new Error("falhou no item 2");
        return item;
      })
    ).rejects.toThrow("falhou no item 2");
  });
});
