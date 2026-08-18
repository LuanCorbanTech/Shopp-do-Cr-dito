"use client";

import { useState } from "react";
import { StatusMultiSelect } from "@/components/StatusMultiSelect";
import { calcularIntervalo, type Periodo } from "@/lib/periodo";

export function RelatoriosClient() {
  const [periodo, setPeriodo] = useState<Periodo>("mes");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [statusSelecionados, setStatusSelecionados] = useState<string[]>([]);
  const [gerando, setGerando] = useState(false);

  function gerarRelatorio() {
    setGerando(true);
    const { from, to } = calcularIntervalo(periodo, customFrom, customTo);
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (statusSelecionados.length > 0) qs.set("status", statusSelecionados.join(","));

    // Navegação simples pra URL do arquivo — o cabeçalho Content-Disposition
    // já faz o navegador baixar em vez de tentar exibir a resposta.
    window.location.assign(`/api/relatorio?${qs.toString()}`);

    // Não tem como saber quando o download realmente terminou (é só uma
    // navegação de GET) — desliga o estado de "gerando" depois de um tempo
    // razoável, só pra não deixar o botão travado pra sempre se algo falhar
    // silenciosamente.
    setTimeout(() => setGerando(false), 3000);
  }

  return (
    <div>
      <h1>Relatórios</h1>
      <p className="subtitle">Exporta as ofertas filtradas por período e status em uma planilha Excel (.xlsx), com todos os dados enriquecidos de cada lead.</p>

      <div className="action-bar">
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

      <div className="chart-card" style={{ maxWidth: 480 }}>
        <h2 style={{ marginTop: 0 }}>O que vai na planilha</h2>
        <p className="field-help" style={{ marginBottom: 16 }}>
          Uma linha por oferta, com colunas de dados pessoais, telefone/WhatsApp, endereço completo e
          dados da oferta — os mesmos campos do modal &quot;Ver tudo&quot; da tela de Ofertas.
        </p>
        <button type="button" onClick={gerarRelatorio} disabled={gerando} style={{ width: "100%" }}>
          {gerando ? "Gerando…" : "⭳ Gerar e baixar relatório (.xlsx)"}
        </button>
      </div>
    </div>
  );
}
