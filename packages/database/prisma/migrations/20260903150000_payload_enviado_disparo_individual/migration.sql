-- Guarda o payload exato mandado em cada tentativa de disparo individual,
-- pra poder conferir na tela da oferta (pedido explícito 03/09). Não
-- guarda headers (evita salvar chave de API em texto puro).

ALTER TABLE "disparo_individual_tentativas" ADD COLUMN "payload_enviado" JSONB;
