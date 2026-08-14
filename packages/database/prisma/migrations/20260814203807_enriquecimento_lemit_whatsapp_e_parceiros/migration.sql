-- AlterTable
ALTER TABLE "webhooks" ADD COLUMN     "esquema_assinatura" TEXT NOT NULL DEFAULT 'ofertas_v1',
ADD COLUMN     "header_assinatura" TEXT NOT NULL DEFAULT 'x-ofertas-signature',
ADD COLUMN     "header_timestamp" TEXT DEFAULT 'x-ofertas-timestamp';

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "dados_pessoa_lemit" JSONB,
ADD COLUMN     "whatsapp_check_iniciado_em" TIMESTAMP(3),
ADD COLUMN     "whatsapp_request_id" TEXT;

-- CreateIndex
CREATE INDEX "idx_offers_whatsapp_request_id" ON "offers"("whatsapp_request_id");

-- CreateIndex
CREATE INDEX "idx_offers_status_whatsapp_check_iniciado" ON "offers"("status", "whatsapp_check_iniciado_em");
