-- Base de upload de leads + proporção de disparo (18/09).
--
-- Nova forma de entrada de leads (upload de planilha .xlsx pelo painel,
-- tela "Subir Base"), processada pelo MESMO funil que já existe pra
-- webhook (reaproveita createOfferIdempotent, idempotência e regra de
-- descarte em 24h) — e uma regra nova de proporção no disparo, misturando
-- ofertas de fornecedor webhook com ofertas de base upload numa razão
-- configurável (ex.: 1 fornecedor : 5 upload). Ver MUDANCAS.md da entrega.
--
-- Sem CREATE/DROP INDEX CONCURRENTLY nessa migração — só ALTER TABLE
-- ADD COLUMN (colunas boolean com DEFAULT ou nullable, ambos instantâneos
-- no Postgres, sem reescrever a tabela) e CREATE TABLE novas, então roda
-- inteira dentro de uma transação normal, sem o problema da migração de
-- 14/09 (ver 20260914130000_indice_unico_cpf_normalizado_webhook).

CREATE TYPE "OrigemWebhookTipo" AS ENUM ('FORNECEDOR', 'BASE_UPLOAD');
CREATE TYPE "StatusLoteUpload" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'ERRO');
CREATE TYPE "StatusLinhaUpload" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CRIADA', 'RESETADA', 'DESCARTADA', 'INVALIDA', 'ERRO');

ALTER TABLE "webhooks" ADD COLUMN "tipo" "OrigemWebhookTipo" NOT NULL DEFAULT 'FORNECEDOR';

ALTER TABLE "offers"
  ADD COLUMN "pular_validacao_lemit" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pular_validacao_whatsapp" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lote_upload_id" TEXT,
  ADD COLUMN "disparo_consultado_em" TIMESTAMP(3);

CREATE TABLE "lotes_upload" (
  "id" TEXT NOT NULL,
  "nome_arquivo" TEXT NOT NULL,
  "webhook_id" TEXT NOT NULL,
  "pular_validacao_lemit" BOOLEAN NOT NULL DEFAULT false,
  "pular_validacao_whatsapp" BOOLEAN NOT NULL DEFAULT false,
  "status" "StatusLoteUpload" NOT NULL DEFAULT 'PENDENTE',
  "total_linhas" INTEGER NOT NULL DEFAULT 0,
  "linhas_processadas" INTEGER NOT NULL DEFAULT 0,
  "ofertas_criadas" INTEGER NOT NULL DEFAULT 0,
  "ofertas_resetadas" INTEGER NOT NULL DEFAULT 0,
  "ofertas_descartadas" INTEGER NOT NULL DEFAULT 0,
  "linhas_invalidas" INTEGER NOT NULL DEFAULT 0,
  "erro" TEXT,
  "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "concluido_em" TIMESTAMP(3),
  CONSTRAINT "lotes_upload_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lote_upload_linhas" (
  "id" TEXT NOT NULL,
  "lote_upload_id" TEXT NOT NULL,
  "nome" TEXT,
  "cpf" TEXT NOT NULL,
  "telefone" TEXT NOT NULL,
  "dados_extras" JSONB,
  "status" "StatusLinhaUpload" NOT NULL DEFAULT 'PENDENTE',
  "erro" TEXT,
  "oferta_id" TEXT,
  "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processado_em" TIMESTAMP(3),
  CONSTRAINT "lote_upload_linhas_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "configuracao_proporcao_disparo" (
  "id" TEXT NOT NULL,
  "peso_fornecedor" INTEGER NOT NULL DEFAULT 1,
  "peso_upload" INTEGER NOT NULL DEFAULT 1,
  "vigente_desde" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "atualizado_em" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "configuracao_proporcao_disparo_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "offers" ADD CONSTRAINT "offers_lote_upload_id_fkey"
  FOREIGN KEY ("lote_upload_id") REFERENCES "lotes_upload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lotes_upload" ADD CONSTRAINT "lotes_upload_webhook_id_fkey"
  FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lote_upload_linhas" ADD CONSTRAINT "lote_upload_linhas_lote_upload_id_fkey"
  FOREIGN KEY ("lote_upload_id") REFERENCES "lotes_upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "idx_offers_lote_upload_id" ON "offers"("lote_upload_id");
CREATE INDEX "idx_offers_disparo_consultado_em" ON "offers"("disparo_consultado_em");
CREATE INDEX "idx_lotes_upload_status" ON "lotes_upload"("status");
CREATE INDEX "idx_lotes_upload_criado_em" ON "lotes_upload"("criado_em");
CREATE INDEX "idx_lote_upload_linhas_lote_status" ON "lote_upload_linhas"("lote_upload_id", "status");

-- Semente da identidade única "Base Upload" (pedido explícito: "todos os
-- lotes de upload cai em uma única identidade") — todo lead de upload usa
-- este MESMO webhook_id, pra que a regra de descarte por duplicidade em
-- 24h e a proporção de disparo (que agrupa por webhooks.tipo) funcionem
-- entre uploads diferentes também, não só dentro do mesmo arquivo.
--
-- ativo=false DE PROPÓSITO: nunca deve responder a uma chamada HTTP real em
-- /webhooks/ofertas/:identificador, mesmo que alguém adivinhe o
-- identificador — findActiveWebhookByIdentificador exige ativo=true.
-- secret_hmac e esquema/headers ficam com valores-placeholder, nunca usados
-- de verdade (a rota nem chega a validar assinatura pra um webhook inativo).
INSERT INTO "webhooks" (
  "id", "identificador", "origem", "secret_hmac", "ativo", "tipo",
  "esquema_assinatura", "header_assinatura", "created_at", "updated_at"
) VALUES (
  '00000000-0000-0000-0000-000000000001', 'base-upload-interna', 'Base Upload (identidade interna)',
  'NAO_USAR_BASE_UPLOAD_INTERNA', false, 'BASE_UPLOAD',
  'token_simples', 'x-nao-usar', now(), now()
);

-- Configuração inicial de proporção — pesos 1:1 (sem preferência nenhuma,
-- equivalente ao comportamento de sempre) até o cliente configurar algo
-- diferente na tela de Integrações.
INSERT INTO "configuracao_proporcao_disparo" (
  "id", "peso_fornecedor", "peso_upload", "vigente_desde", "atualizado_em"
) VALUES (
  '00000000-0000-0000-0000-000000000002', 1, 1, now(), now()
);
