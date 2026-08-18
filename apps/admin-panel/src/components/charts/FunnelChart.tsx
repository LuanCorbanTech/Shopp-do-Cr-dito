"use client";

interface Etapa {
  label: string;
  value: number;
}

// Funil de conversão — barras horizontais com largura proporcional à primeira
// etapa, e a taxa de retenção (% em relação à etapa anterior) entre cada uma.
// CSS puro (sem SVG) — mais simples de manter responsivo que um SVG aqui.
export function FunnelChart({ etapas }: { etapas: Etapa[] }) {
  const base = etapas[0]?.value || 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {etapas.map((etapa, i) => {
        const largura = Math.max(4, (etapa.value / base) * 100);
        const anterior = i > 0 ? etapas[i - 1].value : null;
        const retencao = anterior && anterior > 0 ? Math.round((etapa.value / anterior) * 100) : null;
        return (
          <div key={etapa.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: "var(--text-secondary)" }}>{etapa.label}</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {etapa.value.toLocaleString("pt-BR")}
                {retencao !== null && (
                  <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 8 }}>({retencao}% da etapa anterior)</span>
                )}
              </span>
            </div>
            <div style={{ background: "var(--gridline)", borderRadius: 6, height: 22, overflow: "hidden" }}>
              <div
                style={{
                  width: `${largura}%`,
                  height: "100%",
                  background: "var(--series-1)",
                  borderRadius: 6,
                  transition: "width 0.4s ease",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
