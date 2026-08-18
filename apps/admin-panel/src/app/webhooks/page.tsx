import { WebhooksClient } from "./WebhooksClient";

export const dynamic = "force-dynamic";

// URL pública que os parceiros chamam pra mandar leads — diferente de
// ADMIN_API_BASE_URL (que é só o painel falando com a API internamente).
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL ?? "https://SEU-DOMINIO-AQUI";

export default function WebhooksPage() {
  return <WebhooksClient publicApiBaseUrl={PUBLIC_API_BASE_URL} />;
}
