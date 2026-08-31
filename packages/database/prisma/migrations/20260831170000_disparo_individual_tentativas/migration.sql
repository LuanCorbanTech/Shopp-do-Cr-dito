-- Registra toda tentativa do "Disparo individual" (worker8) — antes só
-- existia como log de sistema, sem ficar visível em lugar nenhum da tela.
-- Não usa FK pra "endpoints" (tabela de um mecanismo de roteamento mais
-- antigo, separado) porque os endpoints do Disparo individual são uma
-- lista simples (JSON) configurada no painel Integrações, não linhas nessa
-- tabela.

CREATE TABLE "disparo_individual_tentativas" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "endpoint_url" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "sucesso" BOOLEAN NOT NULL,
    "http_status" INTEGER,
    "timeout" BOOLEAN NOT NULL DEFAULT false,
    "erro" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disparo_individual_tentativas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_disparo_individual_tentativas_offer_id" ON "disparo_individual_tentativas"("offer_id");

ALTER TABLE "disparo_individual_tentativas" ADD CONSTRAINT "disparo_individual_tentativas_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
