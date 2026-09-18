import { logger } from "@plataforma-ofertas/shared";
import type { UploadBasePort } from "@plataforma-ofertas/domain";

// Worker 12 — Base de upload (18/09): processa em segundo plano as linhas
// das planilhas enviadas pela tela "Subir Base" (uma de cada vez, mas em
// lotes pequenos por ciclo, igual aos outros workers de polling). Cada
// linha vira uma oferta de verdade pelo MESMO caminho de idempotência do
// webhook (ver UploadBasePort.processarLinha / prisma-upload-base-repository.ts)
// — dali em diante, segue o funil normal (Facta -> Lemit -> WhatsApp ->
// disparo), a não ser que o lote tenha marcado pra pular Lemit e/ou
// WhatsApp (ver worker1-limit.ts / worker2-whatsapp.ts).
//
// Nunca lança: processarLinha já captura qualquer falha inesperada e marca
// a linha como "erro" em vez de travar o ciclo inteiro por causa de 1 linha
// ruim (planilha grande, não pode um CPF mal formatado parar o resto).

export interface RunUploadBaseWorkerOnceParams {
  port: UploadBasePort;
  batchSize?: number;
}

export async function runUploadBaseWorkerOnce(params: RunUploadBaseWorkerOnceParams): Promise<number> {
  const { port, batchSize = 50 } = params;

  const linhas = await port.claimLinhasPendentes(batchSize);
  let processadas = 0;

  for (const linha of linhas) {
    const resultado = await port.processarLinha(linha.id);
    processadas += 1;
    if (resultado === "erro") {
      logger.warn({ linhaId: linha.id, loteUploadId: linha.loteUploadId }, "Falha ao processar linha de upload");
    }
  }

  return processadas;
}
