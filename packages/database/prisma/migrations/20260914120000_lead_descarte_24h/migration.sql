-- Regra de descarte por 24h (14/09) — pedido explícito: "se eu receber o CPF
-- que já existe hoje no banco, quero validar se recebi ele nas últimas 24h;
-- se estiver nessa janela, descarta; se for mais do que 24 horas, faz o
-- update e deixa entrar no fluxo padrão de novo."
--
-- Essa migração roda em transação normal (nenhum CONCURRENTLY aqui) — só o
-- índice único que dá suporte à parte "não duplica" da regra está na
-- migração seguinte (20260914130000), que precisa rodar sem transação.

-- 1) Nova coluna: data/hora da última vez que esse (webhook, CPF) foi
-- ACEITO (criado ou resetado) — nunca avançada por um descarte. Criada
-- opcional primeiro pra poder fazer o backfill; depois de preenchida pra
-- todo mundo, vira NOT NULL com default pra linhas novas.
ALTER TABLE "offers" ADD COLUMN "ultimo_recebimento_webhook_em" TIMESTAMP(3);

-- 2) Backfill: para ofertas que já existem, a "última vez que foi aceito" é
-- a própria data de criação (é a informação mais próxima que já temos —
-- não sabemos retroativamente se uma oferta antiga já tinha sido resetada
-- antes dessa migração existir).
UPDATE "offers" SET "ultimo_recebimento_webhook_em" = "created_at" WHERE "ultimo_recebimento_webhook_em" IS NULL;

-- 3) Trava a coluna: obrigatória pra todo mundo a partir de agora, com
-- default pra ofertas novas (o INSERT atômico do createOfferIdempotent já
-- manda o valor explicitamente, mas o default cobre qualquer outro caminho
-- de criação, ex.: scripts administrativos, testes manuais).
ALTER TABLE "offers" ALTER COLUMN "ultimo_recebimento_webhook_em" SET NOT NULL;
ALTER TABLE "offers" ALTER COLUMN "ultimo_recebimento_webhook_em" SET DEFAULT CURRENT_TIMESTAMP;

-- 4) Contador "total geral" de leads descartados por duplicidade em 24h
-- (pedido explícito: só um total, não por parceiro/CPF — por isso não tem
-- coluna de offer_id/cpf aqui, de propósito, pra não custar nada extra no
-- caminho de descarte).
CREATE TABLE "webhook_lead_descartados" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_lead_descartados_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_webhook_lead_descartados_criado_em" ON "webhook_lead_descartados"("criado_em");

ALTER TABLE "webhook_lead_descartados" ADD CONSTRAINT "webhook_lead_descartados_webhook_id_fkey"
  FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
