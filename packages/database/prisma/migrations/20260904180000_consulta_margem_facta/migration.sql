-- Nova primeira etapa do funil (04/09, pedido explícito): consulta de
-- margem na base offline da Facta, antes de tudo o que já existia.

ALTER TYPE "OfferStatus" ADD VALUE 'MARGEM_APROVADA';
ALTER TYPE "OfferStatus" ADD VALUE 'MARGEM_NEGATIVA';
ALTER TYPE "OfferStatus" ADD VALUE 'AGUARDANDO_CONSULTA_ONLINE';
ALTER TYPE "OfferStatus" ADD VALUE 'CONSULTANDO_MARGEM_FACTA';

ALTER TABLE "offers" ADD COLUMN "valor_margem_disponivel_facta" DECIMAL(14,2);
ALTER TABLE "offers" ADD COLUMN "dados_facta_offline" JSONB;
ALTER TABLE "offers" ADD COLUMN "tentativas_margem_facta" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "offers" ADD COLUMN "proxima_tentativa_margem_em" TIMESTAMP(3);
