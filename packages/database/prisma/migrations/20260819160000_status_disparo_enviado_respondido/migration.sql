-- Novos status pro endpoint POST /api/v1/leads/status (o sistema de disparo
-- de WhatsApp informa quando manda a mensagem, e de novo quando o cliente
-- responde) — ver comentário no schema.prisma.

ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'DISPARO_ENVIADO';
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'DISPARO_RESPONDIDO';
