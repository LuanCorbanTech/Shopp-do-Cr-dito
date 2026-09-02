import { adminApiFetch } from "@/lib/api";
import { TarefasClient } from "./TarefasClient";

export const dynamic = "force-dynamic";

interface WebhookOpcao {
  id: string;
  identificador: string;
  origem: string;
}

export default async function TarefasPage() {
  let webhooks: WebhookOpcao[] = [];
  let erroWebhooks: string | null = null;
  try {
    webhooks = await adminApiFetch<WebhookOpcao[]>("/admin/webhooks");
  } catch (e) {
    erroWebhooks = e instanceof Error ? e.message : String(e);
  }

  return <TarefasClient webhooks={webhooks} erroWebhooks={erroWebhooks} />;
}
