import { describe, expect, it, beforeAll, afterAll } from "vitest";
import IORedis from "ioredis";
import { checkAndIncrementCapacity, reserveCapacity } from "./capacity";

// Testes de integração reais contra Redis (não mockados) — requer REDIS_URL
// disponível (ver docker-compose.yml / serviço redis no CI).
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: IORedis;

beforeAll(() => {
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await redis.quit();
});

describe("checkAndIncrementCapacity", () => {
  it("permite até o limite e bloqueia depois", async () => {
    const key = `test:capacity:${Date.now()}:sequencial`;
    await redis.del(key);

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await checkAndIncrementCapacity(redis, key, 3, 60));
    }

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(await redis.get(key)).toBe("3");
  });

  it("é seguro sob concorrência real (20 chamadas paralelas, limite 10)", async () => {
    const key = `test:capacity:${Date.now()}:concorrente`;
    await redis.del(key);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkAndIncrementCapacity(redis, key, 10, 60))
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(await redis.get(key)).toBe("10");
  });
});

describe("reserveCapacity", () => {
  it("concede o lote inteiro quando cabe dentro do limite", async () => {
    const key = `test:capacity:${Date.now()}:lote-cabe`;
    await redis.del(key);

    const granted = await reserveCapacity(redis, key, 10, 60, 5);

    expect(granted).toBe(5);
    expect(await redis.get(key)).toBe("5");
  });

  it("concede só o que resta quando o lote pedido excede o limite (o bug original do Worker 4)", async () => {
    const key = `test:capacity:${Date.now()}:lote-parcial`;
    await redis.del(key);
    await reserveCapacity(redis, key, 2, 60, 2); // já consumiu os 2 slots da janela

    const granted = await reserveCapacity(redis, key, 2, 60, 10);

    expect(granted).toBe(0);
    expect(await redis.get(key)).toBe("2"); // nunca ultrapassa o limite configurado
  });

  it("concede parcialmente e não deixa o contador passar do limite", async () => {
    const key = `test:capacity:${Date.now()}:lote-3-de-10`;
    await redis.del(key);

    const granted = await reserveCapacity(redis, key, 3, 60, 10);

    expect(granted).toBe(3);
    expect(await redis.get(key)).toBe("3");
  });

  it("é seguro sob concorrência real (lotes paralelos, soma nunca excede o limite)", async () => {
    const key = `test:capacity:${Date.now()}:lote-concorrente`;
    await redis.del(key);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveCapacity(redis, key, 15, 60, 3))
    );

    const totalGranted = results.reduce((sum, g) => sum + g, 0);
    expect(totalGranted).toBe(15);
    expect(await redis.get(key)).toBe("15");
  });
});
