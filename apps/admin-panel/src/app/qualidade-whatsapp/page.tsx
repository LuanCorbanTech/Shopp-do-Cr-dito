import { adminApiFetch } from "@/lib/api";
import { formatarDataHora } from "@/lib/data-hora";
import {
  alternarBmContaAtiva,
  alternarQualidadeWhatsappAtivo,
  alternarRelatorioQualidadeWhatsappAtivo,
  alternarWabaContaAtiva,
  atualizarBmConta,
  criarWabaConta,
  salvarConfigQualidadeWhatsapp,
  salvarConfigRelatorioQualidadeWhatsapp,
} from "./actions";
import { ExcluirBmButton } from "./ExcluirBmButton";
import { ExcluirWabaButton } from "./ExcluirWabaButton";
import { NovaBmForm } from "./NovaBmForm";
import { TestarWabaButton } from "./TestarWabaButton";

export const dynamic = "force-dynamic";

interface WabaContaQualidadeWhatsapp {
  id: string;
  wabaId: string;
  nome: string | null;
  ativo: boolean;
  ultimaConsultaEm: string | null;
  ultimoErro: string | null;
  totalNumeros: number;
  porQualidade: Record<string, number>;
}

interface BmContaQualidadeWhatsapp {
  id: string;
  nome: string;
  ativo: boolean;
  tokenConfigurado: boolean;
  tokenMascarado: string | null;
  ultimaConsultaEm: string | null;
  ultimoErro: string | null;
  wabas: WabaContaQualidadeWhatsapp[];
  porQualidade: Record<string, number>;
  tier: string | null;
}

interface QualidadeWhatsappConfigStatus {
  ativo: boolean;
  intervaloSegundos: number | null;
  versaoGraphApi: string | null;
}

interface QualidadeWhatsappRelatorioConfigStatus {
  ativo: boolean;
  intervaloSegundos: number | null;
  webhookUrl: string | null;
}

interface ResumoQualidadeWhatsapp {
  totalNumeros: number;
  totalBms: number;
  totalWabas: number;
  porQualidade: Record<string, number>;
  porTier: Record<string, number>;
  ultimaAtualizacao: string | null;
}

interface NumeroWhatsappListItem {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string;
  messagingLimitTier: string | null;
  status: string | null;
  atualizadoEm: string;
  wabaId: string;
  wabaNome: string | null;
  bmContaId: string;
  bmNome: string;
}

const ROTULO_QUALIDADE: Record<string, { label: string; badge: string }> = {
  GREEN: { label: "Alta", badge: "good" },
  YELLOW: { label: "Média", badge: "warning" },
  RED: { label: "Baixa", badge: "critical" },
  UNKNOWN: { label: "Desconhecida", badge: "neutral" },
};

function badgeQualidade(rating: string) {
  const info = ROTULO_QUALIDADE[rating] ?? { label: rating, badge: "neutral" };
  return (
    <span className={`badge ${info.badge}`}>
      {info.label}
    </span>
  );
}

// Ordem fixa (pior → melhor, com desconhecida entre vermelha e amarela —
// mesma ordem usada em avaliarPioraQualidade/QualidadeHistoricoChart) pras
// pílulas de resumo saírem sempre na mesma sequência.
const ORDEM_QUALIDADE_PILLS = ["RED", "UNKNOWN", "YELLOW", "GREEN"] as const;
const CLASSE_QUALIDADE_PILL: Record<string, string> = {
  GREEN: "q-good",
  YELLOW: "q-warning",
  RED: "q-critical",
  UNKNOWN: "q-neutral",
};

// Resumo compacto de quantos números estão em cada nível de qualidade —
// usado tanto no card da BM (soma de todas as WABAs) quanto em cada linha
// de WABA — pra dar pra ver de cara se tem número problemático, sem
// precisar abrir a lista de números lá embaixo.
function ResumoQualidadePills({ porQualidade }: { porQualidade: Record<string, number> }) {
  const entradas = ORDEM_QUALIDADE_PILLS.map((rating) => ({ rating, quantidade: porQualidade[rating] ?? 0 })).filter(
    (e) => e.quantidade > 0
  );
  if (entradas.length === 0) {
    return <span className="q-pill-empty">sem números ainda</span>;
  }
  return (
    <div className="q-breakdown">
      {entradas.map((e) => (
        <span className={`q-pill ${CLASSE_QUALIDADE_PILL[e.rating]}`} key={e.rating}>
          <span className="dot" />
          {e.quantidade}
        </span>
      ))}
    </div>
  );
}

function inicialBm(nome: string): string {
  return nome.trim().charAt(0).toUpperCase() || "?";
}

// Tier vem cru da Meta (ex.: "TIER_10K", "TIER_UNLIMITED") — só tira o
// prefixo "TIER_" pra ficar mais legível no badge; nunca inventa nada além
// disso, então um valor novo/desconhecido que a Meta venha a criar ainda
// aparece direito (só sem o prefixo).
function formatarTier(tier: string): string {
  return tier.startsWith("TIER_") ? tier.slice("TIER_".length) : tier;
}

export default async function QualidadeWhatsappPage({
  searchParams,
}: {
  searchParams: { bmContaId?: string; qualityRating?: string; busca?: string };
}) {
  let config: QualidadeWhatsappConfigStatus | null = null;
  let erroConfig: string | null = null;
  try {
    config = await adminApiFetch<QualidadeWhatsappConfigStatus>("/admin/qualidade-whatsapp/config");
  } catch (e) {
    erroConfig = e instanceof Error ? e.message : String(e);
  }

  let relatorioConfig: QualidadeWhatsappRelatorioConfigStatus | null = null;
  let erroRelatorioConfig: string | null = null;
  try {
    relatorioConfig = await adminApiFetch<QualidadeWhatsappRelatorioConfigStatus>("/admin/qualidade-whatsapp/relatorio-config");
  } catch (e) {
    erroRelatorioConfig = e instanceof Error ? e.message : String(e);
  }

  let resumo: ResumoQualidadeWhatsapp | null = null;
  let erroResumo: string | null = null;
  try {
    resumo = await adminApiFetch<ResumoQualidadeWhatsapp>("/admin/qualidade-whatsapp/resumo");
  } catch (e) {
    erroResumo = e instanceof Error ? e.message : String(e);
  }

  let bms: BmContaQualidadeWhatsapp[] = [];
  let erroBms: string | null = null;
  try {
    bms = await adminApiFetch<BmContaQualidadeWhatsapp[]>("/admin/qualidade-whatsapp/bms");
  } catch (e) {
    erroBms = e instanceof Error ? e.message : String(e);
  }

  const filtros = new URLSearchParams();
  if (searchParams.bmContaId) filtros.set("bmContaId", searchParams.bmContaId);
  if (searchParams.qualityRating) filtros.set("qualityRating", searchParams.qualityRating);
  if (searchParams.busca) filtros.set("busca", searchParams.busca);

  let numeros: NumeroWhatsappListItem[] = [];
  let erroNumeros: string | null = null;
  try {
    numeros = await adminApiFetch<NumeroWhatsappListItem[]>(
      `/admin/qualidade-whatsapp/numeros${filtros.toString() ? `?${filtros.toString()}` : ""}`
    );
  } catch (e) {
    erroNumeros = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Qualidade WhatsApp</h1>
      <p className="subtitle">
        Monitora a qualidade e o limite de disparo dos números dentro de cada BM (Business Manager), direto da
        API oficial da Meta. Cada BM tem seu próprio token (o app é criado dentro da própria BM) — uma BM pode ter
        mais de uma WABA.
      </p>

      {erroResumo && <p className="empty-state">Não foi possível carregar o resumo: {erroResumo}</p>}
      {resumo && (
        <>
          <div className="stat-grid">
            <div className="stat-tile">
              <div className="value">{resumo.totalNumeros}</div>
              <div className="label">Números monitorados</div>
            </div>
            <div className="stat-tile">
              <div className="value">{resumo.totalBms}</div>
              <div className="label">BMs cadastradas</div>
            </div>
            <div className="stat-tile">
              <div className="value">{resumo.totalWabas}</div>
              <div className="label">WABAs cadastradas</div>
            </div>
            <div className="stat-tile">
              <div className="value" style={{ fontSize: 14 }}>
                {formatarDataHora(resumo.ultimaAtualizacao)}
              </div>
              <div className="label">Última consulta</div>
            </div>
          </div>

          <div className="stat-grid" style={{ marginTop: 12 }}>
            {(["GREEN", "YELLOW", "RED", "UNKNOWN"] as const).map((rating) => (
              <div className="stat-tile" key={rating}>
                <div className="value">{resumo!.porQualidade[rating] ?? 0}</div>
                <div className="label">{badgeQualidade(rating)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <h1 style={{ marginTop: 40 }}>Consulta automática</h1>
      <p className="subtitle">
        A cada ciclo, consulta TODAS as WABAs ativas cadastradas na Meta (sem lote nem rodízio — toda vez é
        todo mundo). Nenhum limite de chamadas por hora é documentado oficialmente pra esse endpoint no momento
        desta entrega — se a Meta reclamar de excesso de chamadas, aumente a frequência do ciclo abaixo (não
        precisa reiniciar nada, vale no próximo ciclo).
      </p>

      {erroConfig && <p className="empty-state">Não foi possível carregar: {erroConfig}</p>}
      {config && (
        <div className="card">
          <div className="toggle-form">
            <strong>Consulta automática</strong>
            <span className={`badge ${config.ativo ? "good" : "neutral"}`}>
              {config.ativo ? "● ATIVADO" : "○ DESATIVADO"}
            </span>
            <form action={alternarQualidadeWhatsappAtivo.bind(null, !config.ativo)}>
              <button type="submit" className={config.ativo ? "secondary" : ""}>
                {config.ativo ? "Desativar" : "Ativar"}
              </button>
            </form>
          </div>

          <form action={salvarConfigQualidadeWhatsapp} style={{ marginTop: 16, display: "grid", gap: 10, maxWidth: 480 }}>
            <input type="hidden" name="ativo" value={config.ativo ? "on" : "off"} />
            <div>
              <label className="field-label" htmlFor="intervaloSegundos">
                Frequência do ciclo (segundos)
              </label>
              <input
                id="intervaloSegundos"
                name="intervaloSegundos"
                type="number"
                min={10}
                step={1}
                defaultValue={config.intervaloSegundos ?? 60}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="versaoGraphApi">
                Versão da Graph API da Meta
              </label>
              <p className="field-help">
                Ex.: v21.0. A Meta aposenta versões antigas periodicamente — troque aqui quando precisar, sem
                precisar de um deploy novo.
              </p>
              <input id="versaoGraphApi" name="versaoGraphApi" type="text" placeholder="v21.0" defaultValue={config.versaoGraphApi ?? ""} />
            </div>
            <button type="submit">Salvar</button>
          </form>
        </div>
      )}

      <h1 style={{ marginTop: 40 }}>Webhook de Alerta</h1>
      <p className="subtitle">
        No seu próprio ciclo (independente da consulta automática acima), manda 1 POST com TODOS os números
        cadastrados e a qualidade atual de cada um (alta, média, baixa ou desconhecida) — não é mais só quando
        piora, é um retrato completo a cada ciclo.
      </p>

      {erroRelatorioConfig && <p className="empty-state">Não foi possível carregar: {erroRelatorioConfig}</p>}
      {relatorioConfig && (
        <div className="card">
          <div className="toggle-form">
            <strong>Webhook de Alerta</strong>
            <span className={`badge ${relatorioConfig.ativo ? "good" : "neutral"}`}>
              {relatorioConfig.ativo ? "● ATIVADO" : "○ DESATIVADO"}
            </span>
            <form action={alternarRelatorioQualidadeWhatsappAtivo.bind(null, !relatorioConfig.ativo)}>
              <button type="submit" className={relatorioConfig.ativo ? "secondary" : ""}>
                {relatorioConfig.ativo ? "Desativar" : "Ativar"}
              </button>
            </form>
          </div>

          <form action={salvarConfigRelatorioQualidadeWhatsapp} style={{ marginTop: 16, display: "grid", gap: 10, maxWidth: 480 }}>
            <input type="hidden" name="ativo" value={relatorioConfig.ativo ? "on" : "off"} />
            <div>
              <label className="field-label" htmlFor="relatorioIntervaloSegundos">
                Frequência do ciclo (segundos)
              </label>
              <input
                id="relatorioIntervaloSegundos"
                name="intervaloSegundos"
                type="number"
                min={10}
                step={1}
                defaultValue={relatorioConfig.intervaloSegundos ?? 300}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="webhookUrl">
                URL do webhook
              </label>
              <p className="field-help">
                Deixe em branco pra manter desativado mesmo com o toggle em ATIVADO — sem URL, o ciclo é
                ignorado.
              </p>
              <input
                id="webhookUrl"
                name="webhookUrl"
                type="text"
                placeholder="https://seu-sistema.com/webhook/qualidade-whatsapp"
                defaultValue={relatorioConfig.webhookUrl ?? ""}
              />
            </div>
            <button type="submit">Salvar</button>
          </form>
        </div>
      )}

      <h1 style={{ marginTop: 40 }}>BMs cadastradas</h1>
      <p className="subtitle">
        Cada BM usa o token do próprio app criado dentro dela pra consultar todas as WABAs cadastradas abaixo
        dela na Meta.
      </p>

      {erroBms && <p className="empty-state">Não foi possível carregar: {erroBms}</p>}

      <div className="bm-grid">
        {bms.map((bm) => {
          const totalCritico = bm.porQualidade.RED ?? 0;
          return (
            <div className="bm-card" key={bm.id}>
              <div className="bm-head">
                <div className="bm-avatar">{inicialBm(bm.nome)}</div>
                <div className="bm-identity">
                  <div className="bm-name">{bm.nome}</div>
                  <div className="bm-badges">
                    <span className={`badge ${bm.ativo ? "good" : "neutral"}`}>{bm.ativo ? "● ATIVA" : "○ DESATIVADA"}</span>
                    <span className={`badge ${bm.tokenConfigurado ? "good" : "critical"}`}>
                      {bm.tokenConfigurado ? `TOKEN ...${bm.tokenMascarado}` : "SEM TOKEN"}
                    </span>
                    {bm.tier && <span className="badge neutral">Limite: {formatarTier(bm.tier)}</span>}
                    {totalCritico > 0 && (
                      <span className="badge critical">
                        ⚠ {totalCritico} número{totalCritico > 1 ? "s" : ""} crítico{totalCritico > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div className="bm-actions">
                  <form action={alternarBmContaAtiva.bind(null, bm.id, !bm.ativo)}>
                    <button type="submit" className="secondary">
                      {bm.ativo ? "Desativar" : "Ativar"}
                    </button>
                  </form>
                  <ExcluirBmButton id={bm.id} nome={bm.nome} />
                </div>
              </div>

              {bm.ultimoErro && (
                <div className="bm-erro-bm">Último erro ao consultar a Meta: {bm.ultimoErro}</div>
              )}

              <div className="bm-stats">
                <div className="bm-stat">
                  <div className="value">{bm.wabas.length}</div>
                  <div className="label">WABA{bm.wabas.length === 1 ? "" : "s"}</div>
                </div>
                <div className="bm-stat">
                  <div className="value">{bm.wabas.reduce((soma, w) => soma + w.totalNumeros, 0)}</div>
                  <div className="label">Número{bm.wabas.reduce((soma, w) => soma + w.totalNumeros, 0) === 1 ? "" : "s"} monitorado{bm.wabas.reduce((soma, w) => soma + w.totalNumeros, 0) === 1 ? "" : "s"}</div>
                </div>
                <div className="bm-stat bm-stat-qualidade">
                  <div className="value">
                    <ResumoQualidadePills porQualidade={bm.porQualidade} />
                  </div>
                  <div className="label">Qualidade dos números</div>
                </div>
                <div className="bm-stat">
                  <div className="value" style={{ fontSize: 14 }}>{formatarDataHora(bm.ultimaConsultaEm)}</div>
                  <div className="label">Última consulta</div>
                </div>
              </div>

              <details style={{ marginTop: 16 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>Editar nome/token</summary>
                <form action={atualizarBmConta.bind(null, bm.id)} style={{ marginTop: 10, display: "grid", gap: 8, maxWidth: 420 }}>
                  <input name="nome" type="text" defaultValue={bm.nome} placeholder="Nome da BM" required />
                  <input
                    name="tokenAcesso"
                    type="password"
                    autoComplete="off"
                    placeholder={bm.tokenConfigurado ? "deixe em branco para manter o token atual" : "cole o token aqui"}
                  />
                  <button type="submit" className="secondary">
                    Salvar
                  </button>
                </form>
              </details>

              <h3 className="section-label" style={{ marginTop: 20 }}>
                WABAs dessa BM
              </h3>

              <div className="waba-list">
                {bm.wabas.map((waba) => {
                  const wabaCritica = (waba.porQualidade.RED ?? 0) > 0;
                  return (
                    <div className="waba-row" key={waba.id}>
                      <div className="waba-id-block">
                        {waba.nome ? (
                          <>
                            <div className="waba-title">{waba.nome}</div>
                            <div className="waba-id-mono">{waba.wabaId}</div>
                          </>
                        ) : (
                          <div className="waba-title waba-id-mono" style={{ fontSize: 14, color: "var(--text-primary)" }}>
                            {waba.wabaId}
                          </div>
                        )}
                      </div>
                      <div className="waba-meta">
                        <span className={`badge ${waba.ativo ? "good" : "neutral"}`} style={{ width: "fit-content" }}>
                          {waba.ativo ? "Ativa" : "Inativa"}
                        </span>
                      </div>
                      <div className="waba-meta">
                        <span>
                          {waba.totalNumeros} número{waba.totalNumeros === 1 ? "" : "s"}
                        </span>
                        <span>{formatarDataHora(waba.ultimaConsultaEm)}</span>
                      </div>
                      <ResumoQualidadePills porQualidade={waba.porQualidade} />
                      <div className="waba-actions">
                        <TestarWabaButton wabaContaId={waba.id} />
                        <form action={alternarWabaContaAtiva.bind(null, waba.id, !waba.ativo)}>
                          <button type="submit" className="secondary" style={{ fontSize: 12, padding: "4px 8px" }}>
                            {waba.ativo ? "Desativar" : "Ativar"}
                          </button>
                        </form>
                        <ExcluirWabaButton id={waba.id} wabaId={waba.wabaId} />
                      </div>
                      {waba.ultimoErro && (
                        <div className="waba-row-error">{waba.ultimoErro}</div>
                      )}
                      {wabaCritica && (
                        <div className="waba-row-error">
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ verticalAlign: -2, marginRight: 4 }}
                          >
                            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                          {waba.porQualidade.RED} número{(waba.porQualidade.RED ?? 0) > 1 ? "s" : ""} com qualidade vermelha —
                          risco de a Meta limitar ou bloquear o disparo.{" "}
                          <a href={`/qualidade-whatsapp?bmContaId=${bm.id}&qualityRating=RED#numeros`}>Ver número(s) →</a>
                        </div>
                      )}
                    </div>
                  );
                })}
                {bm.wabas.length === 0 && <p className="empty-state">Nenhuma WABA cadastrada nessa BM ainda.</p>}
              </div>

              <form action={criarWabaConta.bind(null, bm.id)} className="waba-add-form">
                <input name="wabaId" type="text" placeholder="WABA_ID" required />
                <input name="nome" type="text" placeholder="Apelido (opcional)" />
                <button type="submit" className="secondary">
                  Adicionar WABA
                </button>
              </form>
            </div>
          );
        })}

        {bms.length === 0 && !erroBms && <p className="empty-state">Nenhuma BM cadastrada ainda.</p>}
      </div>

      <h1 style={{ marginTop: 36 }}>Adicionar BM</h1>
      <NovaBmForm />

      <h1 id="numeros" style={{ marginTop: 40 }}>
        Números
      </h1>

      <form method="GET" className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label className="field-label" htmlFor="filtro-bm">
            BM
          </label>
          <select id="filtro-bm" name="bmContaId" defaultValue={searchParams.bmContaId ?? ""}>
            <option value="">Todas</option>
            {bms.map((bm) => (
              <option key={bm.id} value={bm.id}>
                {bm.nome}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="filtro-qualidade">
            Qualidade
          </label>
          <select id="filtro-qualidade" name="qualityRating" defaultValue={searchParams.qualityRating ?? ""}>
            <option value="">Todas</option>
            <option value="GREEN">Alta</option>
            <option value="YELLOW">Média</option>
            <option value="RED">Baixa</option>
            <option value="UNKNOWN">Desconhecida</option>
          </select>
        </div>
        <div style={{ flex: "1 1 200px" }}>
          <label className="field-label" htmlFor="filtro-busca">
            Buscar (telefone ou nome verificado)
          </label>
          <input id="filtro-busca" name="busca" type="text" defaultValue={searchParams.busca ?? ""} />
        </div>
        <button type="submit" className="secondary">
          Filtrar
        </button>
      </form>

      {erroNumeros && <p className="empty-state">Não foi possível carregar: {erroNumeros}</p>}

      <div className="table-scroll" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Número</th>
              <th>Nome verificado</th>
              <th>BM / WABA</th>
              <th>Qualidade</th>
              <th>Limite de disparo</th>
              <th>Status</th>
              <th>Atualizado em</th>
            </tr>
          </thead>
          <tbody>
            {numeros.map((numero) => (
              <tr key={numero.id}>
                <td>
                  <a href={`/qualidade-whatsapp/numeros/${numero.id}`}>{numero.displayPhoneNumber}</a>
                </td>
                <td>{numero.verifiedName ?? "—"}</td>
                <td style={{ fontSize: 13 }}>
                  {numero.bmNome}
                  <br />
                  <code style={{ fontSize: 11 }}>{numero.wabaNome ?? numero.wabaId}</code>
                </td>
                <td>{badgeQualidade(numero.qualityRating)}</td>
                <td>{numero.messagingLimitTier ?? "—"}</td>
                <td>{numero.status ?? "—"}</td>
                <td style={{ fontSize: 13 }}>{formatarDataHora(numero.atualizadoEm)}</td>
              </tr>
            ))}
            {numeros.length === 0 && !erroNumeros && (
              <tr>
                <td colSpan={7} className="empty-state">
                  Nenhum número encontrado. Cadastre uma BM e uma WABA acima, ou ajuste os filtros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
