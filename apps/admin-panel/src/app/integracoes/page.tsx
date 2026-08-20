import { adminApiFetch } from "@/lib/api";
import { setLimitEnabled, salvarCredenciais, toggleRelatorioPeriodico, salvarRelatorioPeriodico } from "./actions";
import { formatarDataHora } from "@/lib/data-hora";

export const dynamic = "force-dynamic";

interface LimitStatus {
  ativo: boolean;
  processados: number;
  erros: number;
  ultimaExecucao: string | null;
}

interface CredencialStatus {
  apiKeyConfigurada: boolean;
  apiKeyMascarada: string | null;
  baseUrl: string | null;
  intervaloSegundos: number | null;
  limiteRequisicoesPorCiclo: number | null;
  loteMinimo: number | null;
  loteMaximo: number | null;
  tempoMaximoEsperaLoteHoras: number | null;
}

interface CredenciaisIntegracoes {
  lemit: CredencialStatus;
  whatsapp: CredencialStatus;
}

interface RelatorioPeriodicoStatus {
  ativo: boolean;
  endpointUrl: string | null;
  intervaloHoras: number | null;
}

export default async function IntegracoesPage() {
  let status: LimitStatus | null = null;
  let error: string | null = null;
  try {
    status = await adminApiFetch<LimitStatus>("/admin/integrations/limit");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  let credenciais: CredenciaisIntegracoes | null = null;
  let erroCredenciais: string | null = null;
  try {
    credenciais = await adminApiFetch<CredenciaisIntegracoes>("/admin/integrations/credenciais");
  } catch (e) {
    erroCredenciais = e instanceof Error ? e.message : String(e);
  }

  let relatorioPeriodico: RelatorioPeriodicoStatus | null = null;
  let erroRelatorioPeriodico: string | null = null;
  try {
    relatorioPeriodico = await adminApiFetch<RelatorioPeriodicoStatus>("/admin/integrations/relatorio-periodico");
  } catch (e) {
    erroRelatorioPeriodico = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Integrações / Validação de telefone</h1>
      <p className="subtitle">
        Controle da consulta à API Limit (Lemit). Quando desativada, o telefone
        original é usado sem nenhuma chamada externa — as ofertas nunca ficam presas.
      </p>

      {error && <p className="empty-state">Não foi possível carregar: {error}</p>}

      {status && (
        <div className="card">
          <div className="toggle-form">
            <strong>API Limit</strong>
            <span className={`badge ${status.ativo ? "good" : "neutral"}`}>
              {status.ativo ? "● ATIVADO" : "○ DESATIVADO"}
            </span>
            <form action={setLimitEnabled.bind(null, !status.ativo)}>
              <button type="submit" className={status.ativo ? "secondary" : ""}>
                {status.ativo ? "Desativar" : "Ativar"}
              </button>
            </form>
          </div>

          <div className="stat-grid" style={{ marginTop: 20 }}>
            <div className="stat-tile">
              <div className="value">{status.processados}</div>
              <div className="label">Processados</div>
            </div>
            <div className="stat-tile">
              <div className="value">{status.erros}</div>
              <div className="label">Erros</div>
            </div>
            <div className="stat-tile">
              <div className="value" style={{ fontSize: 14 }}>
                {formatarDataHora(status.ultimaExecucao)}
              </div>
              <div className="label">Última execução</div>
            </div>
          </div>
        </div>
      )}

      <h1 style={{ marginTop: 40 }}>Credenciais</h1>
      <p className="subtitle">
        Chaves usadas pelos workers para chamar a Lemit e a CorbanTech. Salvar aqui vale a partir
        do próximo ciclo do worker (poucos segundos) — não precisa reiniciar nada no servidor.
        Deixe o campo da chave em branco para manter a chave atual e só trocar a URL.
      </p>

      {erroCredenciais && <p className="empty-state">Não foi possível carregar: {erroCredenciais}</p>}

      {credenciais && (
        <div className="card-grid" style={{ display: "grid", gap: 20, gridTemplateColumns: "1fr 1fr" }}>
          <CredencialForm
            titulo="Lemit (consulta por CPF)"
            integracao="lemit"
            status={credenciais.lemit}
            baseUrlPlaceholder="https://api.lemit.com.br (padrão, deixe em branco)"
            labelIntervalo="Frequência da CRON de Consulta Lemit (em segundos)"
            intervaloPadrao={5}
            limitePadrao={20}
          />
          <CredencialForm
            titulo="CorbanTech (validação de WhatsApp)"
            integracao="whatsapp"
            status={credenciais.whatsapp}
            baseUrlPlaceholder="https://SEU-DOMINIO (raiz da API da CorbanTech)"
            labelIntervalo="Frequência da CRON de Validação de WhatsApp (em segundos)"
            intervaloPadrao={5}
            limitePadrao={20}
          />
        </div>
      )}

      <h1 style={{ marginTop: 40 }}>Relatório periódico</h1>
      <p className="subtitle">
        Envia por POST as contagens de HOJE (Total de ofertas recebidas, Aguardando
        processamento, Com Lemit validado, Com Whatsapp validado, Aguardando consulta
        do disparo, Com disparo consultado, Disparo enviado, Disparo respondido, Taxa
        de resposta) para o endpoint cadastrado abaixo, na frequência configurada.
        Requisição POST simples, com header <code>Content-Type: application/json</code>{" "}
        apenas.
      </p>

      {erroRelatorioPeriodico && <p className="empty-state">Não foi possível carregar: {erroRelatorioPeriodico}</p>}

      {relatorioPeriodico && (
        <div className="card">
          <div className="toggle-form">
            <strong>Relatório periódico</strong>
            <span className={`badge ${relatorioPeriodico.ativo ? "good" : "neutral"}`}>
              {relatorioPeriodico.ativo ? "● ATIVADO" : "○ DESATIVADO"}
            </span>
            <form action={toggleRelatorioPeriodico.bind(null, !relatorioPeriodico.ativo)}>
              <button type="submit" className={relatorioPeriodico.ativo ? "secondary" : ""}>
                {relatorioPeriodico.ativo ? "Desativar" : "Ativar"}
              </button>
            </form>
          </div>

          <form action={salvarRelatorioPeriodico} style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 10 }}>
              <label htmlFor="relatorio-endpointUrl" style={{ display: "block", marginBottom: 4 }}>
                URL do endpoint (recebe o POST)
              </label>
              <input
                id="relatorio-endpointUrl"
                name="endpointUrl"
                type="text"
                defaultValue={relatorioPeriodico.endpointUrl ?? ""}
                placeholder="https://seu-sistema.com/webhook/relatorio"
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label htmlFor="relatorio-intervaloHoras" style={{ display: "block", marginBottom: 4 }}>
                Frequência de envio (em horas — ex.: 4 = de 4 em 4 horas)
              </label>
              <input
                id="relatorio-intervaloHoras"
                name="intervaloHoras"
                type="number"
                min={1}
                step={1}
                defaultValue={relatorioPeriodico.intervaloHoras ?? 4}
                style={{ width: "100%" }}
              />
            </div>
            <button type="submit">Salvar</button>
          </form>
        </div>
      )}
    </div>
  );
}

function CredencialForm({
  titulo,
  integracao,
  status,
  baseUrlPlaceholder,
  labelIntervalo,
  intervaloPadrao,
  limitePadrao,
}: {
  titulo: string;
  integracao: "lemit" | "whatsapp";
  status: CredencialStatus;
  baseUrlPlaceholder: string;
  labelIntervalo: string;
  intervaloPadrao: number;
  limitePadrao: number;
}) {
  return (
    <div className="card">
      <div className="toggle-form">
        <strong>{titulo}</strong>
        <span className={`badge ${status.apiKeyConfigurada ? "good" : "neutral"}`}>
          {status.apiKeyConfigurada ? "● CHAVE CONFIGURADA" : "○ SEM CHAVE"}
        </span>
      </div>
      {status.apiKeyConfigurada && (
        <p className="subtitle" style={{ marginTop: 4 }}>
          Chave atual termina em: <code>{status.apiKeyMascarada}</code>
        </p>
      )}
      <form action={salvarCredenciais.bind(null, integracao)} style={{ marginTop: 12 }}>
        <div style={{ marginBottom: 10 }}>
          <label htmlFor={`${integracao}-apiKey`} style={{ display: "block", marginBottom: 4 }}>
            Chave da API {status.apiKeyConfigurada ? "(deixe em branco para manter a atual)" : ""}
          </label>
          <input
            id={`${integracao}-apiKey`}
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={status.apiKeyConfigurada ? "••••••••" : "cole a chave aqui"}
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label htmlFor={`${integracao}-baseUrl`} style={{ display: "block", marginBottom: 4 }}>
            URL base (opcional)
          </label>
          <input
            id={`${integracao}-baseUrl`}
            name="baseUrl"
            type="text"
            defaultValue={status.baseUrl ?? ""}
            placeholder={baseUrlPlaceholder}
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label htmlFor={`${integracao}-intervaloSegundos`} style={{ display: "block", marginBottom: 4 }}>
            {labelIntervalo}
          </label>
          <input
            id={`${integracao}-intervaloSegundos`}
            name="intervaloSegundos"
            type="number"
            min={1}
            step={1}
            defaultValue={status.intervaloSegundos ?? intervaloPadrao}
            style={{ width: "100%" }}
          />
        </div>

        {integracao === "whatsapp" && (
          <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", margin: "18px 0 8px" }}>
            Validação unitária
          </h3>
        )}
        <div style={{ marginBottom: 10 }}>
          <label htmlFor={`${integracao}-limiteRequisicoesPorCiclo`} style={{ display: "block", marginBottom: 4 }}>
            Limite de requisições por ciclo (rate limit)
          </label>
          <input
            id={`${integracao}-limiteRequisicoesPorCiclo`}
            name="limiteRequisicoesPorCiclo"
            type="number"
            min={1}
            step={1}
            defaultValue={status.limiteRequisicoesPorCiclo ?? limitePadrao}
            style={{ width: "100%" }}
          />
        </div>

        {integracao === "whatsapp" && (
          <>
            <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", margin: "18px 0 8px" }}>
              Validação em lote
            </h3>
            <div style={{ marginBottom: 10 }}>
              <label htmlFor={`${integracao}-loteMinimo`} style={{ display: "block", marginBottom: 4 }}>
                Mínimo de números para disparar um lote de validação
              </label>
              <input
                id={`${integracao}-loteMinimo`}
                name="loteMinimo"
                type="number"
                min={1}
                step={1}
                defaultValue={status.loteMinimo ?? 500}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label htmlFor={`${integracao}-loteMaximo`} style={{ display: "block", marginBottom: 4 }}>
                Teto de segurança por lote
              </label>
              <input
                id={`${integracao}-loteMaximo`}
                name="loteMaximo"
                type="number"
                min={1}
                step={1}
                defaultValue={status.loteMaximo ?? 5000}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label htmlFor={`${integracao}-tempoMaximoEsperaLoteHoras`} style={{ display: "block", marginBottom: 4 }}>
                Tempo máximo de espera pelo lote (horas)
              </label>
              <input
                id={`${integracao}-tempoMaximoEsperaLoteHoras`}
                name="tempoMaximoEsperaLoteHoras"
                type="number"
                min={1}
                step={1}
                defaultValue={status.tempoMaximoEsperaLoteHoras ?? 2}
                style={{ width: "100%" }}
              />
            </div>
          </>
        )}
        <button type="submit">Salvar</button>
      </form>
    </div>
  );
}
