"use client";

import { useState } from "react";
import type { DisparoIndividualEndpointStatus } from "./page";

let contadorIdTemporario = 0;
function gerarIdTemporario() {
  contadorIdTemporario += 1;
  return `novo-${Date.now()}-${contadorIdTemporario}`;
}

// Editor da lista de endpoints do "Disparo individual" — precisa ser client
// component porque a lista é editada (adicionar/remover/ativar/trocar
// modelo linha por linha) antes de salvar, o resto da página (Server
// Component) não consegue fazer isso sozinho. O estado inteiro vai num
// campo escondido (JSON), que o Server Action (salvarDisparoIndividual, em
// actions.ts) lê e repassa pra API.
//
// "Modelo" decide o FORMATO que cada endpoint recebe (corpo e cabeçalhos
// diferentes) — hoje: Hyperflow (formato original) e Ararahq (corpo
// simples + autenticação). Endpoints Ararahq usam a chave de API cadastrada
// mais abaixo na tela (uma só, compartilhada por todos eles).
export default function DisparoIndividualEndpointsEditor({
  endpointsIniciais,
}: {
  endpointsIniciais: DisparoIndividualEndpointStatus[];
}) {
  const [endpoints, setEndpoints] = useState<DisparoIndividualEndpointStatus[]>(
    endpointsIniciais.length > 0
      ? endpointsIniciais
      : [{ id: gerarIdTemporario(), url: "", ativo: true, modelo: "hyperflow" }]
  );

  function atualizarUrl(id: string, url: string) {
    setEndpoints((atual) => atual.map((e) => (e.id === id ? { ...e, url } : e)));
  }

  function atualizarModelo(id: string, modelo: "hyperflow" | "ararahq") {
    setEndpoints((atual) => atual.map((e) => (e.id === id ? { ...e, modelo } : e)));
  }

  function alternarAtivo(id: string) {
    setEndpoints((atual) => atual.map((e) => (e.id === id ? { ...e, ativo: !e.ativo } : e)));
  }

  function remover(id: string) {
    setEndpoints((atual) => atual.filter((e) => e.id !== id));
  }

  function adicionar() {
    setEndpoints((atual) => [...atual, { id: gerarIdTemporario(), url: "", ativo: true, modelo: "hyperflow" }]);
  }

  const ativosCount = endpoints.filter((e) => e.ativo && e.url.trim() !== "").length;
  const temArarahqAtivo = endpoints.some((e) => e.ativo && e.url.trim() !== "" && e.modelo === "ararahq");

  return (
    <div>
      <input type="hidden" name="endpointsJson" value={JSON.stringify(endpoints)} />
      <label style={{ display: "block", marginBottom: 6 }}>
        Endpoints (recebem o POST, 1 lead por vez — cada um ativo conta como um &quot;canal&quot; a mais)
      </label>
      {endpoints.map((endpoint, i) => (
        <div key={endpoint.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <input
            type="text"
            value={endpoint.url}
            onChange={(e) => atualizarUrl(endpoint.id, e.target.value)}
            placeholder={`https://seu-sistema.com/webhook/lead-${i + 1}`}
            style={{ flex: 1 }}
          />
          <select
            value={endpoint.modelo}
            onChange={(e) => atualizarModelo(endpoint.id, e.target.value as "hyperflow" | "ararahq")}
            style={{ width: 130 }}
            title="Formato do corpo e dos cabeçalhos que esse endpoint espera receber"
          >
            <option value="hyperflow">Hyperflow</option>
            <option value="ararahq">Ararahq</option>
          </select>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              whiteSpace: "nowrap",
              cursor: "pointer",
              userSelect: "none",
            }}
            title={endpoint.ativo ? "Ativo — recebe leads" : "Inativo — não recebe leads, mas fica salvo"}
          >
            <input type="checkbox" checked={endpoint.ativo} onChange={() => alternarAtivo(endpoint.id)} />
            {endpoint.ativo ? "Ativo" : "Inativo"}
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() => remover(endpoint.id)}
            disabled={endpoints.length === 1}
            title={endpoints.length === 1 ? "Precisa ter ao menos 1 linha (deixe em branco se não usar)" : "Remover"}
          >
            Remover
          </button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={adicionar} style={{ marginTop: 4 }}>
        + Adicionar endpoint
      </button>
      <p className="field-help" style={{ marginTop: 8 }}>
        {ativosCount === 0
          ? "Nenhum endpoint ativo com URL preenchida — o disparo individual não vai enviar nada até ter pelo menos 1."
          : `${ativosCount} endpoint(s) ativo(s) — cada ciclo manda até ${ativosCount} lead(s) de uma vez (1 por endpoint, em paralelo).`}
        {temArarahqAtivo && " Tem endpoint Ararahq ativo — não esqueça de preencher a chave de API da Ararahq mais abaixo."}
      </p>
    </div>
  );
}
