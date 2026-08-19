-- Novo status terminal pra quando a Lemit responde 404 (CPF sem registro do
-- lado deles) — antes entrava na fila de retry como ERRO_TELEFONE, o que não
-- fazia sentido (tentar de novo nunca "acha" um CPF que não existe na base).
-- Ver comentário no schema.prisma.

ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'CPF_INVALIDO';
