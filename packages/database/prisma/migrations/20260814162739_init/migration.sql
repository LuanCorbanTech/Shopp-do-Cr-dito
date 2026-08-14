-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('RECEBIDO', 'PROCESSANDO_TELEFONE', 'TELEFONE_ATUALIZADO', 'VALIDANDO_WHATSAPP', 'WHATSAPP_VALIDADO', 'AGUARDANDO_ROTEAMENTO', 'AGUARDANDO_ENVIO', 'EM_PROCESSAMENTO_ENVIO', 'ENVIADO', 'SEM_WHATSAPP', 'SEM_ROTA_CONFIGURADA', 'ERRO_TELEFONE', 'ERRO_VALIDACAO_WHATSAPP', 'ERRO_ENVIO', 'CANCELADO', 'EXPIRADO');

-- CreateEnum
CREATE TYPE "DispatchQueueStatus" AS ENUM ('AGUARDANDO', 'RESERVADO', 'PROCESSADO', 'FALHOU');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('SUCESSO', 'FALHA', 'RETRYING');

-- CreateEnum
CREATE TYPE "HttpMethod" AS ENUM ('GET', 'POST', 'PUT', 'PATCH', 'DELETE');

-- CreateEnum
CREATE TYPE "AuthType" AS ENUM ('NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC', 'HMAC');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "identificador" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "secret_hmac" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "nome" TEXT,
    "cpf" TEXT,
    "telefone_original" TEXT NOT NULL,
    "telefone_atualizado" TEXT,
    "telefone_validado" TEXT,
    "banco_autorizado" TEXT,
    "produto" TEXT,
    "valor" DECIMAL(14,2),
    "parcelas" INTEGER,
    "webhook_id" TEXT NOT NULL,
    "payload_original" JSONB NOT NULL,
    "dados_adicionais" JSONB,
    "status" "OfferStatus" NOT NULL DEFAULT 'RECEBIDO',
    "routing_rule_id" TEXT,
    "endpoint_id" TEXT,
    "campaign_id" TEXT,
    "reserved_at" TIMESTAMP(3),
    "tentativas_telefone" INTEGER NOT NULL DEFAULT 0,
    "tentativas_whatsapp" INTEGER NOT NULL DEFAULT 0,
    "tentativas_envio" INTEGER NOT NULL DEFAULT 0,
    "proxima_tentativa_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_processing" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "etapa" TEXT NOT NULL,
    "resultado" TEXT NOT NULL,
    "request" JSONB,
    "response" JSONB,
    "http_status" INTEGER,
    "tentativa" INTEGER NOT NULL DEFAULT 1,
    "tempo_execucao_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_processing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_validations" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "limit_ativo_no_momento" BOOLEAN NOT NULL,
    "resposta_limit" JSONB,
    "possui_whatsapp" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "condicoes" JSONB NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "prioridade" INTEGER NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "endpoints" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "metodo_http" "HttpMethod" NOT NULL DEFAULT 'POST',
    "headers" JSONB,
    "auth_type" "AuthType" NOT NULL DEFAULT 'NONE',
    "credenciais_ref" TEXT,
    "capacidade_minuto" INTEGER,
    "capacidade_hora" INTEGER NOT NULL,
    "capacidade_dia" INTEGER,
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "max_tentativas" INTEGER NOT NULL DEFAULT 5,
    "prioridade" INTEGER NOT NULL DEFAULT 10,
    "horario_permitido" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_queue" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "status" "DispatchQueueStatus" NOT NULL DEFAULT 'AGUARDANDO',
    "scheduled_at" TIMESTAMP(3),
    "reserved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatches" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "request" JSONB,
    "response" JSONB,
    "http_status" INTEGER,
    "tentativa" INTEGER NOT NULL DEFAULT 1,
    "status" "DispatchStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "distribuicao_percentual" JSONB,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_configs" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "valor" JSONB NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "valor" JSONB NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT,
    "worker" TEXT,
    "nivel" "LogLevel" NOT NULL DEFAULT 'INFO',
    "mensagem" TEXT NOT NULL,
    "contexto" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_identificador_key" ON "webhooks"("identificador");

-- CreateIndex
CREATE INDEX "idx_offers_status" ON "offers"("status");

-- CreateIndex
CREATE INDEX "idx_offers_created_at" ON "offers"("created_at");

-- CreateIndex
CREATE INDEX "idx_offers_updated_at" ON "offers"("updated_at");

-- CreateIndex
CREATE INDEX "idx_offers_webhook_id" ON "offers"("webhook_id");

-- CreateIndex
CREATE INDEX "idx_offers_endpoint_id" ON "offers"("endpoint_id");

-- CreateIndex
CREATE INDEX "idx_offers_routing_rule_id" ON "offers"("routing_rule_id");

-- CreateIndex
CREATE INDEX "idx_offers_cpf" ON "offers"("cpf");

-- CreateIndex
CREATE INDEX "idx_offers_telefone_validado" ON "offers"("telefone_validado");

-- CreateIndex
CREATE INDEX "idx_offers_reserved_at" ON "offers"("reserved_at");

-- CreateIndex
CREATE INDEX "idx_offers_status_proxima_tentativa" ON "offers"("status", "proxima_tentativa_em");

-- CreateIndex
CREATE UNIQUE INDEX "uq_offer_idempotency" ON "offers"("webhook_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "idx_offer_processing_offer_created" ON "offer_processing"("offer_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_phone_validations_offer_id" ON "phone_validations"("offer_id");

-- CreateIndex
CREATE INDEX "idx_routing_rules_prioridade" ON "routing_rules"("prioridade");

-- CreateIndex
CREATE INDEX "idx_routing_rules_endpoint_id" ON "routing_rules"("endpoint_id");

-- CreateIndex
CREATE INDEX "idx_dispatch_queue_endpoint_status" ON "dispatch_queue"("endpoint_id", "status");

-- CreateIndex
CREATE INDEX "idx_dispatches_endpoint_id" ON "dispatches"("endpoint_id");

-- CreateIndex
CREATE INDEX "idx_dispatches_offer_id" ON "dispatches"("offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_configs_chave_key" ON "integration_configs"("chave");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_chave_key" ON "system_settings"("chave");

-- CreateIndex
CREATE INDEX "idx_logs_offer_id" ON "logs"("offer_id");

-- CreateIndex
CREATE INDEX "idx_logs_created_at" ON "logs"("created_at");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_routing_rule_id_fkey" FOREIGN KEY ("routing_rule_id") REFERENCES "routing_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_processing" ADD CONSTRAINT "offer_processing_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_validations" ADD CONSTRAINT "phone_validations_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_queue" ADD CONSTRAINT "dispatch_queue_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_queue" ADD CONSTRAINT "dispatch_queue_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
