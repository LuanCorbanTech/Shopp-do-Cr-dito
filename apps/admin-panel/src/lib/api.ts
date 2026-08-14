// Cliente HTTP para a API administrativa (apps/api), usado SÓ em Server Components /
// Server Actions — o token nunca é enviado ao bundle do navegador porque
// ADMIN_API_TOKEN (sem prefixo NEXT_PUBLIC_) só existe no processo do servidor Next.js.

const API_BASE_URL = process.env.ADMIN_API_BASE_URL ?? "http://localhost:3000";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN ?? "";

export class AdminApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "AdminApiError";
  }
}

export async function adminApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_API_TOKEN}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AdminApiError(`Admin API respondeu ${response.status}: ${body}`, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
