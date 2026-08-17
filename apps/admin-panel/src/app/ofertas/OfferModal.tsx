"use client";

import { useState } from "react";

// Modal simples (sem biblioteca externa) que mostra todos os campos da oferta
// — a tabela principal só mostra Nome/CPF/WhatsApp pra não ficar poluída (ver
// page.tsx), e esse botão "Ver tudo" é onde o resto da informação enriquecida
// pela Lemit fica disponível, sob demanda.
export interface OfferFullInfo {
  id: string;
  externalId: string | null;
  nome: string | null;
  cpf: string | null;
  sexo: string | null;
  nomeMae: string | null;
  dataNascimento: string | null;
  email: string | null;
  telefoneOriginal: string | null;
  telefoneLemit: string | null;
  telefoneValidado: string | null;
  whatsappLemit: boolean | null;
  possuiWhatsapp: boolean | null;
  endereco: string | null;
  uf: string | null;
  cep: string | null;
  bairro: string | null;
  cidade: string | null;
  numero: string | null;
  logradouro: string | null;
  complemento: string | null;
  bancoAutorizado: string | null;
  produto: string | null;
  valor: number | null;
  parcelas: number | null;
  status: string;
}

function Campo({ label, value }: { label: string; value: string | number | null | boolean }) {
  let texto: string;
  if (value === null || value === undefined || value === "") texto = "—";
  else if (typeof value === "boolean") texto = value ? "Sim" : "Não";
  else texto = String(value);
  return (
    <div style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
      <div>{texto}</div>
    </div>
  );
}

export function OfferModalButton({ offer }: { offer: OfferFullInfo }) {
  const [aberto, setAberto] = useState(false);

  const dataNascimentoFormatada = offer.dataNascimento
    ? new Date(offer.dataNascimento).toLocaleDateString("pt-BR")
    : null;

  return (
    <>
      <button type="button" className="secondary" onClick={() => setAberto(true)}>
        Ver tudo
      </button>

      {aberto && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setAberto(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,.5)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface-1)", borderRadius: 10, padding: 24,
              width: "min(560px, 92vw)", maxHeight: "85vh", overflowY: "auto",
              border: "1px solid var(--border)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>{offer.nome ?? "Sem nome"}</h2>
              <button type="button" className="secondary" onClick={() => setAberto(false)}>
                Fechar
              </button>
            </div>

            <h3 style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 16, marginBottom: 4 }}>
              Dados pessoais
            </h3>
            <Campo label="Nome" value={offer.nome} />
            <Campo label="CPF" value={offer.cpf} />
            <Campo label="Sexo" value={offer.sexo} />
            <Campo label="Nome da mãe" value={offer.nomeMae} />
            <Campo label="Data de nascimento" value={dataNascimentoFormatada} />
            <Campo label="E-mail" value={offer.email} />

            <h3 style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 16, marginBottom: 4 }}>
              Telefone / WhatsApp
            </h3>
            <Campo label="Telefone recebido na captação" value={offer.telefoneOriginal} />
            <Campo label="Telefone (segundo a Lemit)" value={offer.telefoneLemit} />
            <Campo label="Tem WhatsApp segundo a Lemit" value={offer.whatsappLemit} />
            <Campo label="Telefone validado com WhatsApp de verdade" value={offer.telefoneValidado} />
            <Campo label="Validação oficial de WhatsApp" value={offer.possuiWhatsapp} />

            <h3 style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 16, marginBottom: 4 }}>
              Endereço
            </h3>
            <Campo label="Endereço completo" value={offer.endereco} />
            <Campo label="Logradouro" value={offer.logradouro} />
            <Campo label="Número" value={offer.numero} />
            <Campo label="Complemento" value={offer.complemento} />
            <Campo label="Bairro" value={offer.bairro} />
            <Campo label="Cidade" value={offer.cidade} />
            <Campo label="UF" value={offer.uf} />
            <Campo label="CEP" value={offer.cep} />

            <h3 style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 16, marginBottom: 4 }}>
              Oferta
            </h3>
            <Campo label="ID externo" value={offer.externalId} />
            <Campo label="Banco autorizado" value={offer.bancoAutorizado} />
            <Campo label="Produto" value={offer.produto} />
            <Campo label="Valor" value={offer.valor} />
            <Campo label="Parcelas" value={offer.parcelas} />
            <Campo label="Status" value={offer.status} />
          </div>
        </div>
      )}
    </>
  );
}
