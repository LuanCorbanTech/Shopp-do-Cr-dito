-- Qualidade WhatsApp (10/09) — monitoramento de qualidade/limite dos números
-- dentro das BMs, via API oficial da Meta. Domínio novo, sem relação com o
-- pipeline de ofertas (Offer/Endpoint/etc.) já existente.

CREATE TABLE "bm_contas" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "token_acesso" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ultima_consulta_em" TIMESTAMP(3),
    "ultimo_erro" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bm_contas_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "waba_contas" (
    "id" TEXT NOT NULL,
    "bm_conta_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "nome" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ultima_consulta_em" TIMESTAMP(3),
    "ultimo_erro" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waba_contas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_waba_contas_waba_id" ON "waba_contas"("waba_id");
CREATE INDEX "idx_waba_contas_bm_conta_id" ON "waba_contas"("bm_conta_id");

ALTER TABLE "waba_contas" ADD CONSTRAINT "waba_contas_bm_conta_id_fkey"
  FOREIGN KEY ("bm_conta_id") REFERENCES "bm_contas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "numeros_whatsapp" (
    "id" TEXT NOT NULL,
    "waba_conta_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone_number" TEXT NOT NULL,
    "verified_name" TEXT,
    "quality_rating" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "messaging_limit_tier" TEXT,
    "status" TEXT,
    "atualizado_em" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "numeros_whatsapp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "numeros_whatsapp_phone_number_id_key" ON "numeros_whatsapp"("phone_number_id");
CREATE INDEX "idx_numeros_whatsapp_waba_conta_id" ON "numeros_whatsapp"("waba_conta_id");
CREATE INDEX "idx_numeros_whatsapp_quality_rating" ON "numeros_whatsapp"("quality_rating");

ALTER TABLE "numeros_whatsapp" ADD CONSTRAINT "numeros_whatsapp_waba_conta_id_fkey"
  FOREIGN KEY ("waba_conta_id") REFERENCES "waba_contas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "numeros_whatsapp_historico" (
    "id" TEXT NOT NULL,
    "numero_id" TEXT NOT NULL,
    "quality_rating" TEXT NOT NULL,
    "messaging_limit_tier" TEXT,
    "status" TEXT,
    "consultado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "numeros_whatsapp_historico_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_numero_historico_numero_consultado" ON "numeros_whatsapp_historico"("numero_id", "consultado_em");

ALTER TABLE "numeros_whatsapp_historico" ADD CONSTRAINT "numeros_whatsapp_historico_numero_id_fkey"
  FOREIGN KEY ("numero_id") REFERENCES "numeros_whatsapp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
