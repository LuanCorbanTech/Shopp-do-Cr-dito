import { describe, expect, it } from "vitest";
import type { LinhaLoteUploadSnapshot, ResultadoProcessamentoLinha, UploadBasePort } from "@plataforma-ofertas/domain";
import { runUploadBaseWorkerOnce } from "./worker12-processar-lote-upload";

// Fake mínimo de UploadBasePort — o worker em si não sabe (nem precisa saber)
// como uma linha é processada por dentro (ver comentário na porta); só
// reage ao resultado ("erro" loga um warn, o resto só conta).
class FakeUploadBasePort implements UploadBasePort {
  linhasPendentes: LinhaLoteUploadSnapshot[] = [];
  resultadosPorLinhaId = new Map<string, ResultadoProcessamentoLinha>();
  linhasProcessadas: string[] = [];

  async claimLinhasPendentes(limit: number): Promise<LinhaLoteUploadSnapshot[]> {
    const claimadas = this.linhasPendentes.slice(0, limit);
    this.linhasPendentes = this.linhasPendentes.slice(limit);
    return claimadas;
  }

  async processarLinha(linhaId: string): Promise<ResultadoProcessamentoLinha> {
    this.linhasProcessadas.push(linhaId);
    return this.resultadosPorLinhaId.get(linhaId) ?? "erro";
  }
}

describe("runUploadBaseWorkerOnce", () => {
  it("reivindica as linhas PENDENTE e processa cada uma, devolvendo o total processado", async () => {
    const port = new FakeUploadBasePort();
    port.linhasPendentes = [
      { id: "linha-1", loteUploadId: "lote-a" },
      { id: "linha-2", loteUploadId: "lote-a" },
      { id: "linha-3", loteUploadId: "lote-a" },
    ];
    port.resultadosPorLinhaId.set("linha-1", "criada");
    port.resultadosPorLinhaId.set("linha-2", "resetada");
    port.resultadosPorLinhaId.set("linha-3", "descartada");

    const total = await runUploadBaseWorkerOnce({ port });

    expect(total).toBe(3);
    expect(port.linhasProcessadas).toEqual(["linha-1", "linha-2", "linha-3"]);
  });

  it("respeita o batchSize passado (não reivindica mais que isso por ciclo)", async () => {
    const port = new FakeUploadBasePort();
    port.linhasPendentes = Array.from({ length: 10 }, (_, i) => ({ id: `linha-${i}`, loteUploadId: "lote-a" }));
    for (const linha of port.linhasPendentes) port.resultadosPorLinhaId.set(linha.id, "criada");

    const total = await runUploadBaseWorkerOnce({ port, batchSize: 4 });

    expect(total).toBe(4);
    expect(port.linhasPendentes.length).toBe(6); // as outras 6 continuam pendentes pro próximo ciclo
  });

  it("uma linha com resultado 'erro' não derruba o ciclo — as outras linhas do mesmo lote continuam sendo processadas", async () => {
    const port = new FakeUploadBasePort();
    port.linhasPendentes = [
      { id: "linha-boa-1", loteUploadId: "lote-a" },
      { id: "linha-com-erro", loteUploadId: "lote-a" },
      { id: "linha-boa-2", loteUploadId: "lote-a" },
    ];
    port.resultadosPorLinhaId.set("linha-boa-1", "criada");
    port.resultadosPorLinhaId.set("linha-com-erro", "erro");
    port.resultadosPorLinhaId.set("linha-boa-2", "criada");

    const total = await runUploadBaseWorkerOnce({ port });

    // Todas as 3 foram CONTADAS como processadas (erro também conta — quem
    // decide o status final de cada linha é processarLinha, não este worker).
    expect(total).toBe(3);
    expect(port.linhasProcessadas).toEqual(["linha-boa-1", "linha-com-erro", "linha-boa-2"]);
  });

  it("quando não há nenhuma linha pendente, devolve 0 sem chamar processarLinha", async () => {
    const port = new FakeUploadBasePort();

    const total = await runUploadBaseWorkerOnce({ port });

    expect(total).toBe(0);
    expect(port.linhasProcessadas).toEqual([]);
  });
});
