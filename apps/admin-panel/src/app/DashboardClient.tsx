"use client";

import { useCallback, useEffect, useState } from "react";
import { FunnelChart } from "@/components/charts/FunnelChart";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { EnviadosRespondidosChart } from "@/components/charts/EnviadosRespondidosChart";
import { RecebidasVsEnviadosChart } from "@/components/charts/RecebidasVsEnviadosChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { StatusMultiSelect } from "@/components/StatusMultiSelect";
import { ComparativoDisparosCard } from "@/components/dashboard/ComparativoDisparosCard";
import { TaxaRespostaCard } from "@/components/dashboard/TaxaRespostaCard";
import { GargaloFunilCard } from "@/components/dashboard/GargaloFunilCard";
import { TempoMedioEtapasCard } from "@/components/dashboard/TempoMedioEtapasCard";
import { PerformanceParceiroCard } from "@/components/dashboard/PerformanceParceiroCard";
import { HorarioRespostaCard } from "@/components/dashboard/HorarioRespostaCard";
import { formatarDeltaPercentual, deltaEhPositivo } from "@/components/dashboard/formatacao";
import { calcularIntervalo, type Periodo } from "@/lib/periodo";
import { formatarDataHora } from "@/lib/data-hora";

interface KpiContagens {
  totalRecebidas: number;
  aguardandoProcessamento: number;
  limiteValidado: number;
  whatsappValidado: number;
  aguardandoConsultaDisparo: number;
  disparoConsultado: number;
  disparoEnviado: number;
  disparoRespondido: number;
}

// "anterior" só vem preenchido quando o filtro de período é um intervalo
// fechado (from E to) — ver dashboardKpis em admin-repository.ts. Alimenta
// os selos de variação (▲/▼) nos cards de KPI e no card de Taxa de Resposta.
interface KpiData extends KpiContagens {
  anterior: KpiContagens | null;
  atualizadoEm: string;
}

interface StatusSummary {
  total: number;
  porStatus: Record<string, number>;
}

interface PontoSerie {
  dia: string;
  recebidas: number;
  processadas: number;
}

interface PontoSerieDisparo {
  dia: string;
  enviados: number;
  respondidos: number;
}

interface PontoSerieRecebidasEnviados {
  dia: string;
  recebidas: number;
  enviados: number;
}

interface PontoHorario {
  hora: number;
  total: number;
}

interface TempoMedioEtapas {
  recebimentoParaDisparoSegundos: number | null;
  disparoParaRespostaSegundos: number | null;
}

interface ParceiroTaxaResposta {
  webhookId: string;
  identificador: string;
  origem: string;
  recebidas: number;
  enviados: number;
  respondidos: number;
  taxaResposta: number | null;
}

const REFRESH_SECONDS = 30;

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
function IconHourglass() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h12M6 22h12" /><path d="M6 2c0 6 6 7 6 10s-6 4-6 10M18 2c0 6-6 7-6 10s6 4 6 10" />
    </svg>
  );
}
function IconMailCheck() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.2 8.4c.1.5.1 1 .1 1.6v6a2 2 0 0 1-2 2H4.7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h9.6" />
      <path d="m2.9 7 8.1 6 2-1.5" />
      <path d="m16 6 2 2 4-4" />
    </svg>
  );
}
function IconCheckCheck() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" />
    </svg>
  );
}

function KpiCard({
  icon,
  value,
  label,
  loading,
  deltaTexto,
  deltaPositivo,
}: {
  icon: React.ReactNode;
  value: number | null;
  label: string;
  loading: boolean;
  deltaTexto?: string | null;
  deltaPositivo?: boolean;
}) {
  return (
    <div className={`kpi-card${loading ? " skeleton" : ""}`}>
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-value">{loading ? "—" : (value ?? 0).toLocaleString("pt-BR")}</div>
      <div className="kpi-label">{label}</div>
      {deltaTexto && <div className={`kpi-delta ${deltaPositivo ? "up" : "down"}`}>{deltaTexto}</div>}
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
  const [serie, setSerie] = useState<PontoSerie[]>([]);
  const [serieDisparo, setSerieDisparo] = useState<PontoSerieDisparo[]>([]);
  const [serieRecebidasEnviados, setSerieRecebidasEnviados] = useState<PontoSerieRecebidasEnviados[]>([]);
  const [horarioResposta, setHorarioResposta] = useState<PontoHorario[]>([]);
  const [tempoMedioEtapas, setTempoMedioEtapas] = useState<TempoMedioEtapas | null>(null);
  const [performanceParceiro, setPerformanceParceiro] = useState<ParceiroTaxaResposta[]>([]);
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
      // Pedido explícito: o filtro de status precisa afetar o Dashboard
      // inteiro (cards + gráficos), não só uma tabela auxiliar — por isso
      // vai junto em TODAS as chamadas abaixo que aceitam esse filtro.
      if (statusSelecionados.length > 0) qs.set("status", statusSelecionados.join(","));

      // Os 4 gráficos/cards de cruzamento de dados (recebidas-vs-enviados,
      // horário de resposta, tempo médio entre etapas, performance por
      // parceiro) usam os marcadores cumulativos de disparo, não o filtro de
      // status — mesmo motivo de dashboard-enviados-vs-respondidos, que já
      // seguia esse padrão antes deste redesign.
      const qsSemStatus = new URLSearchParams();
      if (from) qsSemStatus.set("from", from);
      if (to) qsSemStatus.set("to", to);

      const [
        kpisResp,
        statusResp,
        serieResp,
        serieDisparoResp,
        serieRecebidasEnviadosResp,
        horarioRespostaResp,
        tempoMedioEtapasResp,
        performanceParceiroResp,
      ] = await Promise.all([
        fetch(`/api/dashboard-kpis?${qs.toString()}`, { cache: "no-store" }),
        fetch(`/api/dashboard-summary?${qs.toString()}`, { cache: "no-store" }),
        fetch(`/api/dashboard-timeseries?${qs.toString()}`, { cache: "no-store" }),
        fetch(`/api/dashboard-enviados-vs-respondidos?${qsSemStatus.toString()}`, { cache: "no-store" }),
        fetch(`/api/dashboard-recebidas-vs-enviados?${qsSemStatus.toString()}`, { cache: "no-store" }),
        fetch(`/api/dashboard-horario-resposta?${qsSemStatus.toString()}`, { cache: "no-store" }),
        fetch(`/api/dashboard-tempo-medio-etapas?${qsSemStatus.toString()}`, { cache: "no-store" }),
        fetch(`/api/dashboard-taxa-resposta-parceiro?${qsSemStatus.toString()}`, { cache: "no-store" }),
      ]);
      const kpisData: KpiData = await kpisResp.json();
      const statusData: StatusSummary = await statusResp.json();
      const serieData: PontoSerie[] = await serieResp.json();
      const serieDisparoData: PontoSerieDisparo[] = await serieDisparoResp.json();
      const serieRecebidasEnviadosData: PontoSerieRecebidasEnviados[] = await serieRecebidasEnviadosResp.json();
      const horarioRespostaData: PontoHorario[] = await horarioRespostaResp.json();
      const tempoMedioEtapasData: TempoMedioEtapas = await tempoMedioEtapasResp.json();
      const performanceParceiroData: ParceiroTaxaResposta[] = await performanceParceiroResp.json();
      setKpis(kpisData);
      setStatusSummary(statusData);
      setSerie(Array.isArray(serieData) ? serieData : []);
      setSerieDisparo(Array.isArray(serieDisparoData) ? serieDisparoData : []);
      setSerieRecebidasEnviados(Array.isArray(serieRecebidasEnviadosData) ? serieRecebidasEnviadosData : []);
      setHorarioResposta(Array.isArray(horarioRespostaData) ? horarioRespostaData : []);
      setTempoMedioEtapas(tempoMedioEtapasData ?? null);
      setPerformanceParceiro(Array.isArray(performanceParceiroData) ? performanceParceiroData : []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregando(false);
      setContagem(REFRESH_SECONDS);
    }
  }, [periodo, customFrom, customTo, statusSelecionados]);

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

  const atualizadoTexto = kpis ? formatarDataHora(kpis.atualizadoEm, { second: "2-digit" }) : "—";

  // Selo de variação (▲/▼ vs. período anterior) de cada KPI de vazão — só
  // aparece quando dashboardKpis conseguiu calcular o período anterior (ver
  // comentário na interface KpiData).
  function delta(chave: keyof KpiContagens): { texto: string | null; positivo: boolean } {
    if (!kpis?.anterior) return { texto: null, positivo: true };
    return {
      texto: formatarDeltaPercentual(kpis[chave], kpis.anterior[chave]),
      positivo: deltaEhPositivo(kpis[chave], kpis.anterior[chave]),
    };
  }

  const deltaEnviado = delta("disparoEnviado");
  const deltaRespondido = delta("disparoRespondido");

  return (
    <div>
      <div className="dash-header">
        <div>
          <h1>Dashboard geral</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Visão estratégica do funil de ofertas — do recebimento à resposta do disparo.
          </p>
        </div>

        <div className="dash-filters">
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value as Periodo)}>
            <option value="hoje">Hoje</option>
            <option value="7dias">Últimos 7 dias</option>
            <option value="30dias">Últimos 30 dias</option>
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

      {/* Faixa de destaque — comparativo de disparos + taxa de resposta,
          acima da grade de KPIs (pedido explícito do redesign: esses dois
          indicadores precisam de mais hierarquia visual que os demais). */}
      <div className="highlight-row">
        <ComparativoDisparosCard enviados={kpis?.disparoEnviado ?? null} respondidos={kpis?.disparoRespondido ?? null} />
        <TaxaRespostaCard
          enviados={kpis?.disparoEnviado ?? null}
          respondidos={kpis?.disparoRespondido ?? null}
          enviadosAnterior={kpis?.anterior?.disparoEnviado ?? null}
          respondidosAnterior={kpis?.anterior?.disparoRespondido ?? null}
          serieDisparo={serieDisparo}
        />
      </div>

      <div className="section-label">Funil de validação</div>
      <div className="kpi-grid">
        <KpiCard
          icon={<IconInbox />}
          value={kpis?.totalRecebidas ?? null}
          label="Total de ofertas recebidas"
          loading={carregando && !kpis}
          deltaTexto={delta("totalRecebidas").texto}
          deltaPositivo={delta("totalRecebidas").positivo}
        />
        <KpiCard
          icon={<IconClock />}
          value={kpis?.aguardandoProcessamento ?? null}
          label="Aguardando processamento"
          loading={carregando && !kpis}
        />
        <KpiCard
          icon={<IconShield />}
          value={kpis?.limiteValidado ?? null}
          label="Com Lemit validado"
          loading={carregando && !kpis}
          deltaTexto={delta("limiteValidado").texto}
          deltaPositivo={delta("limiteValidado").positivo}
        />
        <KpiCard
          icon={<IconWhatsapp />}
          value={kpis?.whatsappValidado ?? null}
          label="Com WhatsApp validado"
          loading={carregando && !kpis}
          deltaTexto={delta("whatsappValidado").texto}
          deltaPositivo={delta("whatsappValidado").positivo}
        />
      </div>

      <div className="section-label">Funil de disparo</div>
      <div className="kpi-grid">
        <KpiCard
          icon={<IconHourglass />}
          value={kpis?.aguardandoConsultaDisparo ?? null}
          label="Aguardando consulta de disparo"
          loading={carregando && !kpis}
        />
        <KpiCard
          icon={<IconSend />}
          value={kpis?.disparoConsultado ?? null}
          label="Com disparo consultado"
          loading={carregando && !kpis}
        />
        <KpiCard
          icon={<IconMailCheck />}
          value={kpis?.disparoEnviado ?? null}
          label="Disparo enviado"
          loading={carregando && !kpis}
          deltaTexto={deltaEnviado.texto}
          deltaPositivo={deltaEnviado.positivo}
        />
        <KpiCard
          icon={<IconCheckCheck />}
          value={kpis?.disparoRespondido ?? null}
          label="Disparo respondido"
          loading={carregando && !kpis}
          deltaTexto={deltaRespondido.texto}
          deltaPositivo={deltaRespondido.positivo}
        />
      </div>

      <div className="section-label">Evolução diária</div>
      <div className="chart-grid">
        <div className="chart-card chart-card-wide">
          <h2 style={{ margin: "0 0 4px" }}>Ofertas recebidas × Disparos enviados por dia</h2>
          <p className="chart-sub">Mostra se o volume de entrada está sendo escoado pelo funil na mesma velocidade em que chega.</p>
          <RecebidasVsEnviadosChart dados={serieRecebidasEnviados} />
        </div>

        <div className="chart-card chart-card-wide">
          <h2 style={{ margin: "0 0 16px" }}>Disparo enviado × respondido por dia</h2>
          <EnviadosRespondidosChart dados={serieDisparo} />
        </div>

        <div className="chart-card">
          <h2 style={{ margin: "0 0 16px" }}>Distribuição de erros/descarte</h2>
          {statusSummary ? (
            <DonutChart
              segmentos={[
                { label: "Sem WhatsApp", value: statusSummary.porStatus["SEM_WHATSAPP"] ?? 0, color: "var(--status-warning)" },
                { label: "Erro no telefone", value: statusSummary.porStatus["ERRO_TELEFONE"] ?? 0, color: "var(--status-serious)" },
                { label: "Erro na validação de WhatsApp", value: statusSummary.porStatus["ERRO_VALIDACAO_WHATSAPP"] ?? 0, color: "var(--status-critical)" },
                { label: "Cancelado", value: statusSummary.porStatus["CANCELADO"] ?? 0, color: "var(--text-muted)" },
                { label: "Expirado", value: statusSummary.porStatus["EXPIRADO"] ?? 0, color: "var(--text-secondary)" },
              ]}
            />
          ) : (
            <p className="empty-state">Carregando…</p>
          )}
        </div>

        <div className="chart-card">
          <h2 style={{ margin: "0 0 16px" }}>Funil de conversão</h2>
          {kpis ? (
            <FunnelChart
              etapas={[
                { label: "Recebidas", value: kpis.totalRecebidas },
                { label: "Lemit validado", value: kpis.limiteValidado },
                { label: "WhatsApp validado", value: kpis.whatsappValidado },
                { label: "Disparo consultado", value: kpis.disparoConsultado },
              ]}
            />
          ) : (
            <p className="empty-state">Carregando…</p>
          )}
        </div>

        {/* Mantido para quem já usava esse recorte (recebidas x qualquer
            saída das etapas iniciais, boa ou ruim) — responde uma pergunta
            diferente do gráfico de recebidas x enviados acima. */}
        <div className="chart-card chart-card-wide">
          <h2 style={{ margin: "0 0 16px" }}>Volume recebido × processado por dia</h2>
          <TimeSeriesChart dados={serie} />
          <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>
            <span><span style={{ display: "inline-block", width: 10, height: 2, background: "var(--series-1)", marginRight: 6 }} />Recebidas</span>
            <span><span style={{ display: "inline-block", width: 10, height: 2, background: "var(--status-good)", marginRight: 6 }} />Processadas</span>
          </div>
        </div>
      </div>

      <div className="section-label">Cruzamento de dados inteligentes</div>
      <div className="insight-grid">
        <HorarioRespostaCard dados={horarioResposta} />
        <GargaloFunilCard
          etapas={
            kpis
              ? [
                  { label: "Recebidas", value: kpis.totalRecebidas },
                  { label: "Lemit validado", value: kpis.limiteValidado },
                  { label: "WhatsApp validado", value: kpis.whatsappValidado },
                  { label: "Disparo enviado", value: kpis.disparoEnviado },
                ]
              : []
          }
        />
        <TempoMedioEtapasCard
          recebimentoParaDisparoSegundos={tempoMedioEtapas?.recebimentoParaDisparoSegundos ?? null}
          disparoParaRespostaSegundos={tempoMedioEtapas?.disparoParaRespostaSegundos ?? null}
        />
        <PerformanceParceiroCard dados={performanceParceiro} />
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
