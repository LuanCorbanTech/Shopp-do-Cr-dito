-- Novo modelo de disparo: substitui o motor de roteamento interno (Regras de
-- Roteamento + Endpoints + Worker de Disparo). Ao validar o WhatsApp, a oferta
-- vai direto pra AGUARDANDO_DISPARO; um sistema externo consulta
-- GET /api/v1/leads/aguardando-disparo pra buscar essas ofertas, e cada uma
-- passa pra DISPARO_CONSULTADO automaticamente ao ser lida (nunca mais volta
-- nessa consulta).

-- AlterEnum
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'AGUARDANDO_DISPARO';
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'DISPARO_CONSULTADO';

-- AlterTable
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "data_nascimento" TIMESTAMP(3);
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "possui_whatsapp" BOOLEAN;

-- Índice pro polling do endpoint novo (busca por status, mais antigas primeiro)
CREATE INDEX IF NOT EXISTS "idx_offers_status_created_at_disparo" ON "offers"("status", "created_at");
