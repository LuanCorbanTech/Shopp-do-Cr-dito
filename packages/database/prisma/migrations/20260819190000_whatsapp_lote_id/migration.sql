-- Consulta em LOTE de WhatsApp (mudança pedida em 19/08 pra reduzir custo:
-- volta a checknumber.ai, que exige lote mínimo de 500, no lugar da eKYC
-- Pro usada até aqui) — ver comentário no schema.prisma.

ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "whatsapp_lote_id" TEXT;
CREATE INDEX IF NOT EXISTS "idx_offers_whatsapp_lote_id" ON "offers"("whatsapp_lote_id");
