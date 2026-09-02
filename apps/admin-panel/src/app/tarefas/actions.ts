"use server";

import { revalidatePath } from "next/cache";
import { AdminApiError, adminApiFetch } from "@/lib/api";

export async function criarTarefaAction(dados: {
  nome: string;
  fornecedor: string;
  webhookId: string;
  dataHoraExecucao: string; // ISO, já montado no cliente a partir de data+hora
  quantidadeOfertas: number;
}): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await adminApiFetch("/admin/tarefas", { method: "POST", body: JSON.stringify(dados) });
    revalidatePath("/tarefas");
    return { ok: true };
  } catch (e) {
    const mensagem = e instanceof AdminApiError ? e.friendlyMessage ?? e.message : "Não foi possível criar a tarefa.";
    return { ok: false, mensagem };
  }
}

export async function cancelarTarefaAction(id: string): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await adminApiFetch(`/admin/tarefas/${id}`, { method: "DELETE" });
    revalidatePath("/tarefas");
    return { ok: true };
  } catch (e) {
    const mensagem =
      e instanceof AdminApiError && e.status === 409
        ? "Só é possível cancelar tarefas que ainda não começaram (aguardando a hora chegar)."
        : "Não foi possível cancelar.";
    return { ok: false, mensagem };
  }
}
