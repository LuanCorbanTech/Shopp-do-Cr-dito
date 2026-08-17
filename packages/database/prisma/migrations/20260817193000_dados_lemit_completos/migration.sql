-- "Retrato" completo da resposta da Lemit promovido pra colunas próprias
-- (pedido explícito: sexo, nome_mae, email, telefone, whatsapp, endereço
-- completo — nome/cpf/data_nascimento já existiam). Ver extrairInfoPessoaLemit
-- em @plataforma-ofertas/domain.

-- AlterTable
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "sexo" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "nome_mae" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "telefone_lemit" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "whatsapp_lemit" BOOLEAN;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "endereco" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "uf" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "cep" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "bairro" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "cidade" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "numero" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "logradouro" TEXT;
ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "complemento" TEXT;
