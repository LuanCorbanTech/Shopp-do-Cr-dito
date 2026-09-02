-- Tarefas agendadas de recebimento (liga/desliga um fornecedor numa
-- data/horário marcados, até bater uma meta de ofertas recebidas).

CREATE TABLE "tarefas" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "fornecedor" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "data_hora_execucao" TIMESTAMP(3) NOT NULL,
    "quantidade_ofertas" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "ofertas_recebidas" INTEGER NOT NULL DEFAULT 0,
    "iniciado_em" TIMESTAMP(3),
    "concluido_em" TIMESTAMP(3),
    "erro" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tarefas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_tarefas_webhook_status" ON "tarefas"("webhook_id", "status");
CREATE INDEX "idx_tarefas_status_data" ON "tarefas"("status", "data_hora_execucao");

ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_webhook_id_fkey"
  FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
