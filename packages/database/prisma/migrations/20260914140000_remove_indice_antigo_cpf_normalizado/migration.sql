-- Continuação da migração 20260914130000 — removida pra um arquivo próprio
-- pelo mesmo motivo: CREATE/DROP INDEX CONCURRENTLY só roda fora de
-- transação quando é o ÚNICO comando do arquivo (ver comentário detalhado
-- em 20260914130000_indice_unico_cpf_normalizado_webhook/migration.sql).
--
-- Remove o índice antigo (não-único), que a essa altura já foi substituído
-- pelo índice único "uq_offers_webhook_cpf_normalizado" criado na migração
-- anterior — sem ele, os dois índices ficariam convivendo sem necessidade
-- (redundante, o único já cobre a mesma busca).
DROP INDEX CONCURRENTLY IF EXISTS "idx_offers_webhook_cpf_normalizado";
