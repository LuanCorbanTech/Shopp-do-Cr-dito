// Base de upload (18/09) — "Subir Base": porta usada pelo worker novo
// (worker12-processar-lote-upload) que processa, em segundo plano, as
// linhas de planilhas enviadas pela tela "Subir Base" — ver
// packages/database/prisma/schema.prisma (modelos LoteUpload/LoteUploadLinha)
// e prisma-upload-base-repository.ts para a implementação concreta.
//
// De propósito, o "processar 1 linha" inteiro (validar CPF/telefone, criar
// ou resetar a oferta reaproveitando createOfferIdempotent, atualizar a
// linha e os contadores do lote) fica escondido atrás de UM método só
// (processarLinha) — o worker não precisa saber de nenhum desses passos,
// só reage ao resultado devolvido (pra logar/contar).

export interface LinhaLoteUploadSnapshot {
  id: string;
  loteUploadId: string;
}

export type ResultadoProcessamentoLinha =
  | "criada"
  | "resetada"
  | "descartada"
  | "invalida"
  | "erro";

export interface UploadBasePort {
  /**
   * Reivindica (atomicamente, SKIP LOCKED — mesmo padrão dos outros
   * workers) até `limit` linhas PENDENTE de QUALQUER lote, mais antigas
   * primeiro, marcando-as PROCESSANDO. Nunca duas chamadas concorrentes
   * pegam a mesma linha.
   */
  claimLinhasPendentes(limit: number): Promise<LinhaLoteUploadSnapshot[]>;

  /**
   * Processa UMA linha já reivindicada (PROCESSANDO): valida CPF/telefone,
   * chama o mesmo caminho de criação/reset idempotente que o webhook usa
   * (sempre com o webhookId da identidade única "Base Upload" e as flags
   * pularValidacaoLemit/pularValidacaoWhatsapp do lote dela), grava o
   * resultado na própria linha e incrementa os contadores do LoteUpload —
   * e, se essa era a última linha PENDENTE/PROCESSANDO do lote, marca o
   * lote inteiro como CONCLUIDO. Nunca lança: uma falha inesperada marca a
   * linha como "erro" (guardando a mensagem) em vez de travar o worker.
   */
  processarLinha(linhaId: string): Promise<ResultadoProcessamentoLinha>;
}

// ---------------------------------------------------------------------------
// Proporção de disparo (18/09) — configuração lida/escrita pela tela
// "Integrações" e consultada pelo claimOffersAguardandoDisparo (worker8 e
// GET /api/v1/leads/aguardando-disparo, que reaproveitam o mesmo método).
// ---------------------------------------------------------------------------

export interface ConfiguracaoProporcaoDisparoSnapshot {
  pesoFornecedor: number;
  pesoUpload: number;
  vigenteDesde: Date;
}

export interface ProporcaoDisparoPort {
  buscarConfiguracaoProporcao(): Promise<ConfiguracaoProporcaoDisparoSnapshot>;
  /**
   * Só atualiza (e só reinicia vigenteDesde = agora) quando pelo menos um
   * dos 2 pesos REALMENTE muda — salvar os mesmos valores de novo não
   * reinicia a "janela" de contagem da proporção (ver comentário no
   * schema.prisma, model ConfiguracaoProporcaoDisparo).
   */
  definirConfiguracaoProporcao(params: { pesoFornecedor: number; pesoUpload: number }): Promise<ConfiguracaoProporcaoDisparoSnapshot>;
}
