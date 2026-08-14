-- AlterTable
-- O CPF passou a ser o campo obrigatório na captação de leads (é a partir dele
-- que o Worker 1 consulta a Lemit e enriquece o telefone). O telefone agora é
-- opcional na entrada — pode chegar depois, via Lemit — então a coluna deixa de
-- ser NOT NULL.
ALTER TABLE "offers" ALTER COLUMN "telefone_original" DROP NOT NULL;
