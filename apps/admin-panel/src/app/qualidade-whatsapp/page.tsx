import { adminApiFetch } from "@/lib/api";
import { formatarDataHora } from "@/lib/data-hora";
import {
  alternarBmContaAtiva,
  alternarQualidadeWhatsappAtivo,
  alternarWabaContaAtiva,
  atualizarBmConta,
  criarWabaConta,
  salvarConfigQualidadeWhatsapp,
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
}

interface QualidadeWhatsappConfigStatus {
  ativo: boolean;
  intervaloSegundos: number | null;
  batchSize: number | null;
  versaoGraphApi: string | null;
  webhookAlertaUrl: string | null;
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
  GREEN: { label: "Verde", badge: "good" },
  YELLOW: { label: "Amarela", badge: "warning" },
  RED: { label: "Vermelha", badge: "critical" },
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
        A cada ciclo, consulta um lote de WABAs na Meta (as mais desatualizadas primeiro) — o rodízio cobre
        todas ao longo de vários ciclos. Nenhum limite de chamadas por hora é documentado oficialmente pra esse
        endpoint no momento desta entrega — se a Meta reclamar de excesso de chamadas, aumente o intervalo ou
        reduza o tamanho do lote abaixo (não precisa reiniciar nada, vale no próximo ciclo).
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
              <label className="field-label" htmlFor="batchSize">
                WABAs consultadas por ciclo
              </label>
              <input id="batchSize" name="batchSize" type="number" min={1} step={1} defaultValue={config.batchSize ?? 10} />
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
            <div>
              <label className="field-label" htmlFor="webhookAlertaUrl">
                Webhook de alerta (opcional)
              </label>
              <p className="field-help">
                Quando um número piora (perde qualidade, perde limite de disparo, ou fica com status ruim), manda
                1 POST pra essa URL com os detalhes. Deixe em branco pra usar só o painel, sem notificação.
              </p>
              <input
                id="webhookAlertaUrl"
                name="webhookAlertaUrl"
                type="text"
                placeholder="https://seu-sistema.com/webhook/qualidade-whatsapp"
                defaultValue={config.webhookAlertaUrl ?? ""}
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

      <div style={{ display: "grid", gap: 16 }}>
        {bms.map((bm) => (
          <div className="card" key={bm.id}>
            <div className="toggle-form">
              <strong>{bm.nome}</strong>
              <span className={`badge ${bm.ativo ? "good" : "neutral"}`}>{bm.ativo ? "● ATIVA" : "○ DESATIVADA"}</span>
              <span className={`badge ${bm.tokenConfigurado ? "good" : "critical"}`}>
                {bm.tokenConfigurado ? `TOKEN ...${bm.tokenMascarado}` : "SEM TOKEN"}
              </span>
              <form action={alternarBmContaAtiva.bind(null, bm.id, !bm.ativo)}>
                <button type="submit" className="secondary">
                  {bm.ativo ? "Desativar" : "Ativar"}
                </button>
              </form>
              <ExcluirBmButton id={bm.id} nome={bm.nome} />
            </div>

            {bm.ultimoErro && (
              <p style={{ color: "var(--status-critical)", fontSize: 13, marginTop: 8 }}>Último erro: {bm.ultimoErro}</p>
            )}
            {bm.ultimaConsultaEm && (
              <p className="field-help" style={{ marginTop: 4 }}>Última consulta: {formatarDataHora(bm.ultimaConsultaEm)}</p>
            )}

            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer" }}>Editar nome/token</summary>
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

            <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", margin: "16px 0 8px" }}>
              WABAs dessa BM
            </h3>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>WABA_ID</th>
                    <th>Apelido</th>
                    <th>Status</th>
                    <th>Números</th>
                    <th>Última consulta</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {bm.wabas.map((waba) => (
                    <tr key={waba.id}>
                      <td>
                        <code>{waba.wabaId}</code>
                      </td>
                      <td>{waba.nome ?? "—"}</td>
                      <td>
                        <span className={`badge ${waba.ativo ? "good" : "neutral"}`}>{waba.ativo ? "Ativa" : "Inativa"}</span>
                        {waba.ultimoErro && (
                          <div style={{ color: "var(--status-critical)", fontSize: 12, marginTop: 4, maxWidth: 220 }}>
                            {waba.ultimoErro}
                          </div>
                        )}
                      </td>
                      <td className="num">{waba.totalNumeros}</td>
                      <td style={{ fontSize: 13 }}>{formatarDataHora(waba.ultimaConsultaEm)}</td>
                      <td style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <TestarWabaButton wabaContaId={waba.id} />
                        <form action={alternarWabaContaAtiva.bind(null, waba.id, !waba.ativo)}>
                          <button type="submit" className="secondary" style={{ fontSize: 12, padding: "4px 8px" }}>
                            {waba.ativo ? "Desativar" : "Ativar"}
                          </button>
                        </form>
                        <ExcluirWabaButton id={waba.id} wabaId={waba.wabaId} />
                      </td>
                    </tr>
                  ))}
                  {bm.wabas.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty-state">
                        Nenhuma WABA cadastrada nessa BM ainda.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <form action={criarWabaConta.bind(null, bm.id)} style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input name="wabaId" type="text" placeholder="WABA_ID" required style={{ flex: "1 1 200px" }} />
              <input name="nome" type="text" placeholder="Apelido (opcional)" style={{ flex: "1 1 160px" }} />
              <button type="submit" className="secondary">
                Adicionar WABA
              </button>
            </form>
          </div>
        ))}

        {bms.length === 0 && !erroBms && <p className="empty-state">Nenhuma BM cadastrada ainda.</p>}
      </div>

      <h2 style={{ marginTop: 24 }}>Adicionar BM</h2>
      <NovaBmForm />

      <h1 style={{ marginTop: 40 }}>Números</h1>

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
            <option value="GREEN">Verde</option>
            <option value="YELLOW">Amarela</option>
            <option value="RED">Vermelha</option>
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
