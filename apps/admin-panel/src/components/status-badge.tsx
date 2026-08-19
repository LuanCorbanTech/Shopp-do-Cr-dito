// Cores de status são reservadas (good/warning/critical) e sempre acompanhadas de
// texto — nunca só a cor carrega o significado (ver skill de dataviz, seção de
// acessibilidade). Estados "em progresso" usam um badge neutro (identidade, não status).
const GOOD = new Set(["ENVIADO", "DISPARO_ENVIADO", "DISPARO_RESPONDIDO"]);
const CRITICAL = new Set(["ERRO_TELEFONE", "ERRO_VALIDACAO_WHATSAPP", "ERRO_ENVIO", "CANCELADO", "EXPIRADO"]);
const WARNING = new Set(["SEM_WHATSAPP", "SEM_ROTA_CONFIGURADA"]);

type Variant = "good" | "warning" | "critical" | "neutral";

const ICON: Record<Variant, string> = {
  good: "●",
  warning: "▲",
  critical: "✕",
  neutral: "○",
};

function variantFor(status: string): Variant {
  if (GOOD.has(status)) return "good";
  if (CRITICAL.has(status)) return "critical";
  if (WARNING.has(status)) return "warning";
  return "neutral";
}

export function StatusBadge({ status }: { status: string }) {
  const variant = variantFor(status);
  return (
    <span className={`badge ${variant}`}>
      <span aria-hidden="true">{ICON[variant]}</span>
      {status}
    </span>
  );
}
