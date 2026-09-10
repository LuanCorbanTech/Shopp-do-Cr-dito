-- 2ª etapa da consulta de margem Facta (04/09): consulta ONLINE, pra quem
-- ficou AGUARDANDO_CONSULTA_ONLINE depois da offline não achar nada.

ALTER TYPE "OfferStatus" ADD VALUE 'REGISTRANDO_AUTORIZACAO_ONLINE_FACTA';
ALTER TYPE "OfferStatus" ADD VALUE 'AGUARDANDO_RESULTADO_ONLINE_FACTA';
ALTER TYPE "OfferStatus" ADD VALUE 'CONSULTANDO_RESULTADO_ONLINE_FACTA';

ALTER TABLE "offers" ADD COLUMN "dados_facta_online" JSONB;
ALTER TABLE "offers" ADD COLUMN "tentativas_online_facta" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "offers" ADD COLUMN "proxima_tentativa_online_facta_em" TIMESTAMP(3);
