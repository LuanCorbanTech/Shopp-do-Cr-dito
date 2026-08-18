"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface KpiData {
  totalRecebidas: number;
  aguardandoProcessamento: number;
  limiteValidado: number;
  whatsappValidado: number;
  disparoConsultado: number;
  atualizadoEm: string;
}

interface StatusSummary {
  total: number;
  porStatus: Record<string, number>;
}

const REFRESH_SECONDS = 30;

const TODOS_STATUS = [
  "RECEBIDO",
  "PROCESSANDO_TELEFONE",
  "TELEFONE_ATUALIZADO",
  "VALIDANDO_WHATSAPP",
  "WHATSAPP_VALIDADO",
  "AGUARDANDO_DISPARO",
  "DISPARO_CONSULTADO",
  "SEM_WHATSAPP",
  "ERRO_TELEFONE",
  "ERRO_VALIDACAO_WHATSAPP",
  "CANCELADO",
  "EXPIRADO",
];

type Periodo = "hoje" | "7dias" | "mes" | "personalizado";

function calcularIntervalo(periodo: Periodo, customFrom: string, customTo: string): { from?: string; to?: string } {
  const agora = new Date();
  if (periodo === "hoje") {
    const inicio = new Date(agora);
    inicio.setHours(0, 0, 0, 0);
    return { from: inicio.toISOString(), to: agora.toISOString() };
  }
  if (periodo === "7dias") {
    const inicio = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { from: inicio.toISOString(), to: agora.toISOString() };
  }
  if (periodo === "mes") {
    const inicio = new Date(agora.getFullYear(), agora.getMonth(), 1);
    return { from: inicio.toISOString(), to: agora.toISOString() };
  }
  // personalizado
  return {
    from: customFrom ? new Date(customFrom + "T00:00:00").toISOString() : undefined,
    to: customTo ? new Date(customTo + "T23:59:59").toISOString() : undefined,
  };
}

// Ícones simples embutidos (sem dependência externa) — um por KPI.
function IconInbox() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h4l2 3h4l2-3h4" />
      <path d="M4 12 5.5 5h13L20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function IconWhatsapp() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 1 1 12 0c0 3 1 4.5 2 6H4c1-1.5 2-3 2-6Z" />
      <path d="M9 18a3 3 0 0 0 6 0" />
    </svg>
  );
}
function IconSend() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </svg>
  );
}

function KpiCard({ icon, value, label, loading }: { icon: React.ReactNode; value: number | null; label: string; loading: boolean }) {
  return (
    <div className={`kpi-card${loading ? " skeleton" : ""}`}>
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-value">{loading ? "—" : (value ?? 0).toLocaleString("pt-BR")}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

function StatusMultiSelect({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickFora(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false);
    }
    document.addEventListener("mousedown", onClickFora);
    return () => document.removeEventListener("mousedown", onClickFora);
  }, []);

  function toggle(status: string) {
    onChange(selected.includes(status) ? selected.filter((s) => s !== status) : [...selected, status]);
  }

  const label = selected.length === 0 ? "Todos os status" : `${selected.length} status selecionado(s)`;

  return (
    <div className="multiselect" ref={ref}>
      <button type="button" className="multiselect-btn" onClick={() => setAberto((v) => !v)}>
        {label} <span style={{ fontSize: 10 }}>▾</span>
      </button>
      {aberto && (
        <div className="multiselect-panel">
          {TODOS_STATUS.map((status) => (
            <label key={status}>
              <input type="checkbox" checked={selected.includes(status)} onChange={() => toggle(status)} />
              {status}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function DashboardClient() {
  const [periodo, setPeriodo] = useState<Periodo>("mes");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [statusSelecionados, setStatusSelecionados] = useState<string[]>([]);

  const [kpis, setKpis] = useState<KpiData | null>(null);
  const [statusSummary, setStatusSummary] = useState<StatusSummary | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [contagem, setContagem] = useState(REFRESH_SECONDS);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const { from, to } = calcularIntervalo(periodo, customFrom, customTo);
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);

      const [kpisResp, statusResp] = await Promise.all([
        fetch(`/api/dashboard-kpis?${qs.toString()}`, { cache: "no-store" }),
        fetch(`/api/dashboard-summary`, { cache: "no-store" }),
      ]);
      const kpisData: KpiData = await kpisResp.json();
      const statusData: StatusSummary = await statusResp.json();
      setKpis(kpisData);
      setStatusSummary(statusData);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregando(false);
      setContagem(REFRESH_SECONDS);
    }
  }, [periodo, customFrom, customTo]);

  // Carrega de novo sempre que o período (ou datas personalizadas) mudar.
  useEffect(() => {
    carregar();
  }, [carregar]);

  // "Socket mockado": simula atualização automática via polling a cada 30s —
  // fica fácil de trocar por um WebSocket de verdade depois (o servidor
  // notificaria o cliente, em vez do cliente perguntar a cada intervalo), sem
  // mudar a interface visual (mesmo indicador, mesmo contador).
  useEffect(() => {
    const tick = setInterval(() => {
      setContagem((c) => {
        if (c <= 1) {
          carregar();
          return REFRESH_SECONDS;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [carregar]);

  const agora = kpis ? new Date(kpis.atualizadoEm) : null;
  const atualizadoTexto = agora
    ? agora.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <div>
      <div className="dash-header">
        <div>
          <h1>Dashboard geral</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Total recebido e distribuição das ofertas por etapa do funil.
          </p>
        </div>

        <div className="dash-filters">
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value as Periodo)}>
            <option value="hoje">Hoje</option>
            <option value="7dias">Últimos 7 dias</option>
            <option value="mes">Este mês</option>
            <option value="personalizado">Personalizado</option>
          </select>
          {periodo === "personalizado" && (
            <>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </>
          )}
          <StatusMultiSelect selected={statusSelecionados} onChange={setStatusSelecionados} />
        </div>
      </div>

      <div className="sync-indicator" style={{ marginBottom: 20 }}>
        <span className="sync-dot" aria-hidden="true" />
        Atualizado em {atualizadoTexto} | Atualiza em {contagem}s
      </div>

      {erro && <p className="empty-state">Não foi possível carregar o dashboard: {erro}</p>}

      <div className="kpi-grid">
        <KpiCard icon={<IconInbox />} value={kpis?.totalRecebidas ?? null} label="Total de ofertas recebidas" loading={carregando && !kpis} />
        <KpiCard icon={<IconClock />} value={kpis?.aguardandoProcessamento ?? null} label="Aguardando processamento" loading={carregando && !kpis} />
        <KpiCard icon={<IconShield />} value={kpis?.limiteValidado ?? null} label="Com limite validado (Lemit)" loading={carregando && !kpis} />
        <KpiCard icon={<IconWhatsapp />} value={kpis?.whatsappValidado ?? null} label="Com WhatsApp validado" loading={carregando && !kpis} />
        <KpiCard icon={<IconSend />} value={kpis?.disparoConsultado ?? null} label="Com disparo consultado" loading={carregando && !kpis} />
      </div>

      {statusSelecionados.length > 0 && statusSummary && (
        <>
          <h2>Detalhe por status selecionado</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Ofertas</th>
                </tr>
              </thead>
              <tbody>
                {statusSelecionados.map((s) => (
                  <tr key={s}>
                    <td>{s}</td>
                    <td style={{ textAlign: "right" }}>{(statusSummary.porStatus[s] ?? 0).toLocaleString("pt-BR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
