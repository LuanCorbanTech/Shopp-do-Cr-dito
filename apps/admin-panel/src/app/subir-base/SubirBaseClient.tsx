"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Colunas obrigatórias — exatamente esses nomes, em minúsculo (pedido
// explícito: "o modelo da planilha será: nome, cpf e telefone, tudo
// minusculo"). Qualquer coluna extra além dessas 3 é preservada (vai pro
// dadosExtras da linha, sem tentar adivinhar em qual campo da oferta ela
// deveria virar).
const COLUNAS_OBRIGATORIAS = ["nome", "cpf", "telefone"] as const;

interface LinhaParaEnviar {
  nome: string | null;
  cpf: string;
  telefone: string;
  dadosExtras: Record<string, unknown> | null;
}

interface LoteUploadResumo {
  id: string;
  nomeArquivo: string;
  status: "PENDENTE" | "PROCESSANDO" | "CONCLUIDO" | "ERRO";
  pularValidacaoLemit: boolean;
  pularValidacaoWhatsapp: boolean;
  totalLinhas: number;
  linhasProcessadas: number;
  ofertasCriadas: number;
  ofertasResetadas: number;
  ofertasDescartadas: number;
  linhasInvalidas: number;
  linhasComErro: number;
  erro: string | null;
  criadoEm: string;
  concluidoEm: string | null;
}

const STATUS_LABEL: Record<LoteUploadResumo["status"], string> = {
  PENDENTE: "Aguardando processar",
  PROCESSANDO: "Processando…",
  CONCLUIDO: "Concluído",
  ERRO: "Erro",
};

const STATUS_CLASSE: Record<LoteUploadResumo["status"], string> = {
  PENDENTE: "neutral",
  PROCESSANDO: "good",
  CONCLUIDO: "good",
  ERRO: "critical",
};

function formatarDataHora(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// Lê a planilha .xlsx inteira no navegador (lib xlsx, já instalada) — nada
// disso passa pelo servidor Next.js antes de ser validado, só o resultado
// já extraído (e validado aqui) é que vira o corpo do POST /api/lotes-upload.
async function parsePlanilha(file: File): Promise<{ linhas: LinhaParaEnviar[]; erro?: string }> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const primeiraAba = workbook.SheetNames[0];
  if (!primeiraAba) {
    return { linhas: [], erro: "A planilha não tem nenhuma aba." };
  }
  const sheet = workbook.Sheets[primeiraAba];
  const linhasCruas = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (linhasCruas.length === 0) {
    return { linhas: [], erro: "A planilha não tem nenhuma linha de dados (só o cabeçalho, ou está vazia)." };
  }

  const colunas = Object.keys(linhasCruas[0]);
  const faltando = COLUNAS_OBRIGATORIAS.filter((c) => !colunas.includes(c));
  if (faltando.length > 0) {
    return {
      linhas: [],
      erro: `A planilha precisa ter as colunas "nome", "cpf" e "telefone" (minúsculas, na primeira linha). Faltando: ${faltando.join(", ")}. Colunas encontradas: ${colunas.join(", ") || "(nenhuma)"}.`,
    };
  }

  const linhas: LinhaParaEnviar[] = linhasCruas.map((linhaCrua) => {
    const { nome, cpf, telefone, ...extrasCrus } = linhaCrua;
    const dadosExtras: Record<string, unknown> = {};
    for (const [chave, valor] of Object.entries(extrasCrus)) {
      if (valor !== "" && valor !== null && valor !== undefined) dadosExtras[chave] = valor;
    }
    const nomeTexto = nome != null ? String(nome).trim() : "";
    return {
      nome: nomeTexto !== "" ? nomeTexto : null,
      cpf: String(cpf ?? "").trim(),
      telefone: String(telefone ?? "").trim(),
      dadosExtras: Object.keys(dadosExtras).length > 0 ? dadosExtras : null,
    };
  });

  return { linhas };
}

// Enquanto pelo menos 1 lote está PENDENTE/PROCESSANDO, atualiza a lista a
// cada 5s pra mostrar o progresso do worker12 em segundo plano — sem isso a
// tela ficaria "parada" até o usuário apertar F5 pra ver o resultado.
const TEM_LOTE_EM_ANDAMENTO = (lotes: LoteUploadResumo[]) => lotes.some((l) => l.status === "PENDENTE" || l.status === "PROCESSANDO");

export function SubirBaseClient() {
  const [lotes, setLotes] = useState<LoteUploadResumo[]>([]);
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [erroLista, setErroLista] = useState<string | null>(null);

  const [arquivo, setArquivo] = useState<File | null>(null);
  const [validarLemit, setValidarLemit] = useState(true);
  const [validarWhatsapp, setValidarWhatsapp] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [erroEnvio, setErroEnvio] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const carregarLista = useCallback(async () => {
    try {
      const resp = await fetch("/api/lotes-upload", { cache: "no-store" });
      const json = await resp.json();
      setLotes(Array.isArray(json) ? json : []);
      setErroLista(null);
    } catch (e) {
      setErroLista(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregandoLista(false);
    }
  }, []);

  useEffect(() => {
    carregarLista();
  }, [carregarLista]);

  // Polling só enquanto tem lote em andamento — pra não ficar batendo no
  // servidor pra sempre depois que tudo já concluiu.
  useEffect(() => {
    if (!TEM_LOTE_EM_ANDAMENTO(lotes)) return;
    const id = setInterval(carregarLista, 5000);
    return () => clearInterval(id);
  }, [lotes, carregarLista]);

  async function enviar() {
    if (!arquivo) return;
    setEnviando(true);
    setErroEnvio(null);
    setSucesso(null);
    try {
      const { linhas, erro } = await parsePlanilha(arquivo);
      if (erro) {
        setErroEnvio(erro);
        return;
      }
      const resp = await fetch("/api/lotes-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nomeArquivo: arquivo.name,
          pularValidacaoLemit: !validarLemit,
          pularValidacaoWhatsapp: !validarWhatsapp,
          linhas,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        setErroEnvio(json?.error ?? json?.mensagem ?? `Erro ao enviar (HTTP ${resp.status}).`);
        return;
      }
      setSucesso(`Planilha "${arquivo.name}" enviada — ${linhas.length} linha(s). Processando em segundo plano.`);
      setArquivo(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await carregarLista();
    } catch (e) {
      setErroEnvio(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div>
      <div className="dash-header">
        <div>
          <h1>Subir Base</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Envie uma planilha (.xlsx) com leads pra entrar no funil exatamente como uma oferta recebida por
            webhook — mesma esteira (Facta → Lemit → WhatsApp → disparo), com a opção de pular as etapas de
            validação pra bases já quentes.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 14 }}>
          <label htmlFor="subir-base-arquivo" className="field-label" style={{ display: "block", marginBottom: 6 }}>
            Planilha (.xlsx) — colunas obrigatórias: <code>nome</code>, <code>cpf</code>, <code>telefone</code> (minúsculo,
            na primeira linha). Colunas extras são salvas junto com a oferta.
          </label>
          <input
            id="subir-base-arquivo"
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            onChange={(e) => {
              setArquivo(e.target.files?.[0] ?? null);
              setErroEnvio(null);
              setSucesso(null);
            }}
          />
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={validarLemit}
            onChange={(e) => setValidarLemit(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            Validar CPF na Lemit
            <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)" }}>
              Desmarque se essa base já vem com telefone confirmado — pula essa etapa pra essas linhas.
            </span>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 16, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={validarWhatsapp}
            onChange={(e) => setValidarWhatsapp(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            Validar número no WhatsApp
            <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)" }}>
              Desmarque se essa base já vem confirmada como tendo WhatsApp — pula essa etapa pra essas linhas.
            </span>
          </span>
        </label>

        {erroEnvio && (
          <p className="empty-state" style={{ borderColor: "var(--status-critical)", color: "var(--status-critical)" }}>
            {erroEnvio}
          </p>
        )}
        {sucesso && (
          <p className="empty-state" style={{ borderColor: "var(--status-good)", color: "var(--status-good)" }}>
            ✓ {sucesso}
          </p>
        )}

        <button type="button" onClick={enviar} disabled={!arquivo || enviando}>
          {enviando ? "Enviando…" : "Enviar planilha"}
        </button>
      </div>

      <h1 style={{ marginTop: 8 }}>Bases já enviadas</h1>
      {erroLista && <p className="empty-state">Não foi possível carregar: {erroLista}</p>}

      <div className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Enviado em</th>
                <th>Linhas</th>
                <th>Criadas</th>
                <th>Resetadas</th>
                <th>Descartadas</th>
                <th>Inválidas</th>
                <th>Com erro</th>
                <th>Validações puladas</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {carregandoLista && (
                <tr>
                  <td colSpan={10} className="empty-state">
                    Carregando…
                  </td>
                </tr>
              )}
              {!carregandoLista && lotes.length === 0 && (
                <tr>
                  <td colSpan={10} className="empty-state">
                    Nenhuma base enviada ainda.
                  </td>
                </tr>
              )}
              {lotes.map((lote) => (
                <tr key={lote.id}>
                  <td>{lote.nomeArquivo}</td>
                  <td>{formatarDataHora(lote.criadoEm)}</td>
                  <td>
                    {lote.linhasProcessadas}/{lote.totalLinhas}
                  </td>
                  <td>{lote.ofertasCriadas}</td>
                  <td>{lote.ofertasResetadas}</td>
                  <td>{lote.ofertasDescartadas}</td>
                  <td>{lote.linhasInvalidas}</td>
                  <td>{lote.linhasComErro}</td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {lote.pularValidacaoLemit ? "Lemit" : ""}
                    {lote.pularValidacaoLemit && lote.pularValidacaoWhatsapp ? " + " : ""}
                    {lote.pularValidacaoWhatsapp ? "WhatsApp" : ""}
                    {!lote.pularValidacaoLemit && !lote.pularValidacaoWhatsapp ? "—" : ""}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_CLASSE[lote.status]}`}>{STATUS_LABEL[lote.status]}</span>
                    {lote.status === "ERRO" && lote.erro && (
                      <div className="field-help" style={{ color: "var(--status-critical)", marginTop: 4 }}>
                        {lote.erro}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
