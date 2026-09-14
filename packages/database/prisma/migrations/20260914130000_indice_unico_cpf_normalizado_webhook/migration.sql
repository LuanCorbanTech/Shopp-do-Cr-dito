-- Correção da corrida de duplicatas (14/09) — o índice funcional criado em
-- 11/09 (idx_offers_webhook_cpf_normalizado) só ACELERAVA a checagem de
-- "mesmo parceiro + mesmo CPF", não IMPEDIA duas requisições simultâneas de
-- passarem pela checagem ao mesmo tempo e criarem 2 ofertas duplicadas (foi
-- exatamente isso que aconteceu: 3 pares de duplicatas encontrados e
-- removidos em produção antes dessa migração, todos com poucos
-- milissegundos de diferença entre si).
--
-- Essa migração troca esse índice por um ÍNDICE ÚNICO sobre a mesma
-- expressão — vira o alvo do "ON CONFLICT" do novo UPSERT atômico em
-- createOfferIdempotent (prisma-offers-port.ts), que resolve create/reset/
-- descarte numa única ida ao banco (antes eram 2: um UPDATE tentando achar
-- a oferta existente, e só se não achasse, um INSERT — cada lead novo
-- pagava 2 round trips, causa raiz do timeout de ~50s em lotes grandes da
-- Odysseia). Com um índice ÚNICO, o próprio Postgres garante atomicamente
-- que a corrida não pode mais duplicar, mesmo sob concorrência alta.
--
-- CREATE INDEX CONCURRENTLY e DROP INDEX CONCURRENTLY não podem rodar
-- dentro de uma transação — por isso essa migração fica em um arquivo
-- separado da anterior (20260914120000, que é uma migração transacional
-- normal). O Prisma Migrate detecta a palavra "concurrently" e roda esse
-- arquivo inteiro FORA de uma transação automaticamente — não precisa de
-- nenhum passo manual, o `prisma migrate deploy` do pipeline aplica normal
-- (mais lento que um índice comum, mas não trava a tabela "offers" pra
-- leitura/escrita durante a criação).
--
-- Cria o índice único NOVO primeiro (nome diferente do antigo, os dois
-- convivem por um instante) e só then remove o antigo — se por algum
-- motivo a criação do único falhar (ex.: alguma duplicata nova apareceu
-- entre a limpeza manual feita em produção e esse deploy), o índice antigo
-- continua no lugar e nada quebra.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_offers_webhook_cpf_normalizado"
ON "offers" ("webhook_id", (regexp_replace("cpf", '\D', '', 'g')));

DROP INDEX CONCURRENTLY IF EXISTS "idx_offers_webhook_cpf_normalizado";
