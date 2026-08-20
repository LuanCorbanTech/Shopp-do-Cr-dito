// Fuso horário de negócio do sistema — Brasília (America/Sao_Paulo, UTC-3, sem
// horário de verão desde 2019). Todo carimbo de data/hora exibido no painel
// deve passar por aqui, com o fuso SEMPRE explícito.
//
// Motivo: sem um "timeZone" explícito, Date.toLocaleString() usa o fuso do
// ambiente onde o código roda — o do NAVEGADOR em componentes de cliente
// ("use client"), mas o do SERVIDOR (o droplet, que por padrão vem em UTC)
// em Server Components e Route Handlers. Essa mistura já causava horários
// errados em produção: a timeline da oferta (Server Component) e o
// relatório .xlsx exportado (Route Handler) mostravam a hora do SERVIDOR em
// UTC — 3h adiantada — como se já fosse horário de Brasília, enquanto o
// resto do painel (Dashboard, Usuários, Integrações), sendo client-side,
// só mostrava a hora certa se o navegador de quem estava olhando também
// estivesse configurado em horário de Brasília.
const FUSO_BRASILIA = "America/Sao_Paulo";

/** "20/08/2026 14:32" — data e hora, sempre no fuso de Brasília. */
export function formatarDataHora(iso: string | null | undefined, opcoes: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return "—";
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return "—";
  return data.toLocaleString("pt-BR", {
    timeZone: FUSO_BRASILIA,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...opcoes,
  });
}

/** "20/08/2026" — só a data, sempre no fuso de Brasília. */
export function formatarData(iso: string | null | undefined): string {
  if (!iso) return "—";
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return "—";
  return data.toLocaleDateString("pt-BR", { timeZone: FUSO_BRASILIA });
}
