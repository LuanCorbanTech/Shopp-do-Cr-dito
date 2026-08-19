-- Contadores independentes/cumulativos de "Disparo Enviado" e "Disparo
-- Respondido" no Dashboard — ver comentário no schema.prisma. Guardam a
-- PRIMEIRA vez que cada evento aconteceu, sem nunca serem sobrescritos
-- depois (diferente da coluna "status", que só reflete o estado atual).

ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "disparo_enviado_em" TIMESTAMP(3);
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "disparo_respondido_em" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "idx_offers_disparo_enviado_em" ON "offers"("disparo_enviado_em");
CREATE INDEX IF NOT EXISTS "idx_offers_disparo_respondido_em" ON "offers"("disparo_respondido_em");

-- Backfill: ofertas que já estão em DISPARO_ENVIADO ou DISPARO_RESPONDIDO
-- hoje (criadas antes dessa migration) ganham um valor retroativo baseado em
-- updated_at, pra já aparecerem certas nos contadores/gráfico assim que essa
-- migration rodar, sem esperar um evento novo pra "existir" no histórico.
UPDATE "offers" SET "disparo_enviado_em" = "updated_at"
  WHERE "status" IN ('DISPARO_ENVIADO', 'DISPARO_RESPONDIDO') AND "disparo_enviado_em" IS NULL;
UPDATE "offers" SET "disparo_respondido_em" = "updated_at"
  WHERE "status" = 'DISPARO_RESPONDIDO' AND "disparo_respondido_em" IS NULL;
