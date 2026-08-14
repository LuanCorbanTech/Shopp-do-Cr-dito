"use client";

import { useState } from "react";
import { createWebhook } from "./actions";

// Formulário de criação de webhook, com explicações em português simples pra
// cada campo — pensado pra quem vai cadastrar um parceiro novo sem precisar
// entender de HMAC, headers HTTP, etc. de antemão.
export function NovoWebhookForm({ publicApiBaseUrl }: { publicApiBaseUrl: string }) {
  const [identificador, setIdentificador] = useState("");
  const [esquema, setEsquema] = useState<"ofertas_v1" | "hmac_sha256_simple">("ofertas_v1");

  const identificadorLimpo = identificador.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const urlPreview = `${publicApiBaseUrl}/webhooks/ofertas/${identificadorLimpo || "..."}`;

  return (
    <form action={createWebhook} className="card" style={{ display: "grid", gap: 20, maxWidth: 560 }}>
      <div>
        <label className="field-label" htmlFor="origem">
          1. Nome do parceiro
        </label>
        <p className="field-help">Só aparece aqui no painel, pra você identificar. Ex.: Odysseia.</p>
        <input id="origem" name="origem" placeholder="Ex.: Odysseia" required />
      </div>

      <div>
        <label className="field-label" htmlFor="identificador">
          2. Identificador (vira a URL do webhook)
        </label>
        <p className="field-help">
          Só letras minúsculas, números e hífen. Isso vira o final do endereço que você vai passar
          pro parceiro chamar quando ele tiver um lead novo:
        </p>
        <input
          id="identificador"
          name="identificador"
          placeholder="Ex.: odysseia"
          pattern="[a-z0-9-]+"
          required
          value={identificador}
          onChange={(e) => setIdentificador(e.target.value)}
        />
        <p className="url-preview">
          <code>{urlPreview}</code>
        </p>
      </div>

      <div>
        <p className="field-label">3. Como o parceiro vai assinar cada requisição?</p>
        <p className="field-help">
          Toda requisição vem com uma &quot;assinatura&quot; pra provar que é realmente esse parceiro
          chamando, e não outra pessoa. Existem dois jeitos possíveis — se você não souber qual o
          parceiro usa, pergunte pra eles ou escolha a opção 1 e mande a documentação padrão pra eles
          seguirem.
        </p>

        <label className="radio-option">
          <input
            type="radio"
            name="esquemaAssinatura"
            value="ofertas_v1"
            checked={esquema === "ofertas_v1"}
            onChange={() => setEsquema("ofertas_v1")}
          />
          <span>
            <strong>Opção 1 — Padrão da nossa plataforma (recomendado)</strong>
            <br />
            Use quando <em>você</em> vai ditar as regras pro parceiro (ele ainda não tem um jeito
            próprio de assinar, ou tem flexibilidade). O parceiro manda 2 headers: um com a data/hora
            e outro com a assinatura — isso também impede que alguém reenvie a mesma requisição depois.
          </span>
        </label>

        <label className="radio-option">
          <input
            type="radio"
            name="esquemaAssinatura"
            value="hmac_sha256_simple"
            checked={esquema === "hmac_sha256_simple"}
            onChange={() => setEsquema("hmac_sha256_simple")}
          />
          <span>
            <strong>Opção 2 — Assinatura simples do parceiro</strong>
            <br />
            Use quando o parceiro <em>já tem</em> o próprio jeito de assinar e só manda 1 header
            (mais comum quando é o sistema deles que dita o formato, ex.: Odysseia). Pergunte pra eles
            o nome do header e o segredo.
          </span>
        </label>
      </div>

      {esquema === "ofertas_v1" ? (
        <div>
          <label className="field-label">Nomes dos headers (pode deixar como está)</label>
          <p className="field-help">Já vem com o padrão sugerido — só troque se o parceiro pedir nomes diferentes.</p>
          <div style={{ display: "grid", gap: 8 }}>
            <input name="headerAssinatura" placeholder="Header da assinatura" defaultValue="x-ofertas-signature" />
            <input name="headerTimestamp" placeholder="Header do timestamp" defaultValue="x-ofertas-timestamp" />
          </div>
        </div>
      ) : (
        <div>
          <label className="field-label" htmlFor="headerAssinatura">
            Nome do header que o parceiro vai usar
          </label>
          <p className="field-help">Pergunte pro parceiro. Ex.: X-Odysseia-Signature.</p>
          <input
            id="headerAssinatura"
            name="headerAssinatura"
            placeholder="Ex.: X-Odysseia-Signature"
            required
          />
          <input type="hidden" name="headerTimestamp" value="" />
        </div>
      )}

      <div>
        <label className="field-label" htmlFor="secretHmac">
          4. Segredo (senha compartilhada com o parceiro)
        </label>
        <p className="field-help">
          {esquema === "ofertas_v1"
            ? "Deixe em branco — o sistema gera um segredo seguro automaticamente. Depois de criar, copie esse segredo aqui na tela e envie pro parceiro configurar do lado dele."
            : "Se o parceiro já gerou um segredo do lado dele, cole aqui. Se for você quem vai definir, pode deixar em branco pra gerar automaticamente."}
        </p>
        <input id="secretHmac" name="secretHmac" placeholder="Deixe em branco para gerar automaticamente" />
      </div>

      <button type="submit">Criar webhook</button>
    </form>
  );
}
