import { logger } from "@plataforma-ofertas/shared";
import type { OfferSnapshot } from "@plataforma-ofertas/domain";

// Worker 8 — Disparo individual (push). Diferente do endpoint GET
// /api/v1/leads/aguardando-disparo (onde um sistema externo é quem puxa,
// no ritmo dele), aqui é o CONTRÁRIO: este worker que EMPURRA, um lead por
// vez, pro endpoint que o usuário cadastrar no painel ("Integrações"),
// numa frequência configurável. Pedido explícito: só 1 lead por execução
// (não todos os que estiverem esperando de uma vez) — se sobrar mais gente
// na fila, ela é atendida nos próximos ciclos.
//
// Reaproveita a MESMA claim atômica do endpoint GET
// (claimOffersAguardandoDisparo — UPDATE...RETURNING com SKIP LOCKED): a
// oferta já sai marcada como DISPARO_CONSULTADO no instante em que é
// escolhida, mesmo antes do POST ser tentado. Isso é intencional e é o
// MESMO risco que o endpoint GET já tinha desde sempre: se o POST falhar
// (endpoint fora do ar, timeout), a oferta já ficou marcada como
// "consultada" mesmo assim — ela não volta pra fila sozinha. Documentado
// aqui de propósito pra quem for mexer depois não achar que é bug novo.

export interface DisparoIndividualPort {
  claimOffersAguardandoDisparo(limit: number): Promise<OfferSnapshot[]>;
}

export interface RunDisparoIndividualWorkerOnceParams {
  ativo: boolean;
  endpointUrl?: string | null;
  port: DisparoIndividualPort;
  /** Injeção do fetch — só pra testar sem rede de verdade; em produção usa o fetch global. */
  fetchImpl?: typeof fetch;
}

// Mesmos campos do GET /api/v1/leads/aguardando-disparo (um objeto, não um
// array com "leads" — aqui é sempre 1 por vez).
export interface DisparoIndividualBody {
  id: string;
  externalId: string | null;
  nome: string | null;
  cpf: string | null;
  dataNascimento: string | null;
  telefoneWhatsapp: string | null;
  possuiWhatsapp: boolean | null;
  bancoAutorizado: string | null;
  produto: string | null;
  valor: number | null;
  parcelas: number | null;
}

export function montarDisparoIndividualBody(o: OfferSnapshot): DisparoIndividualBody {
  return {
    id: o.id,
    externalId: o.externalId,
    nome: o.nome,
    cpf: o.cpf,
    dataNascimento: o.dataNascimento ? o.dataNascimento.toISOString() : null,
    telefoneWhatsapp: o.telefoneValidado,
    possuiWhatsapp: o.possuiWhatsapp,
    bancoAutorizado: o.bancoAutorizado,
    produto: o.produto,
    valor: o.valor,
    parcelas: o.parcelas,
  };
}

export async function runDisparoIndividualWorkerOnce(params: RunDisparoIndividualWorkerOnceParams): Promise<number> {
  const { ativo, endpointUrl, port, fetchImpl = fetch } = params;

  if (!ativo) return 0;
  if (!endpointUrl) {
    logger.warn("Disparo individual ativado mas sem endpoint cadastrado no painel — ciclo ignorado");
    return 0;
  }

  const ofertas = await port.claimOffersAguardandoDisparo(1);
  if (ofertas.length === 0) return 0; // ninguém esperando neste ciclo

  const lead = ofertas[0];
  const body = montarDisparoIndividualBody(lead);

  try {
    const resposta = await fetchImpl(endpointUrl, {
      method: "POST",
      // Só este header, mesmo padrão do relatório periódico — nada de
      // Authorization aqui (o endpoint é do próprio usuário).
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resposta.ok) {
      logger.error(
        { endpointUrl, status: resposta.status, offerId: lead.id },
        "Endpoint do disparo individual respondeu com erro — a oferta já ficou marcada como DISPARO_CONSULTADO mesmo assim"
      );
      return 0;
    }
    logger.info({ endpointUrl, offerId: lead.id }, "Lead individual enviado");
    return 1;
  } catch (error) {
    logger.error(
      { endpointUrl, error, offerId: lead.id },
      "Falha ao enviar o lead individual — a oferta já ficou marcada como DISPARO_CONSULTADO mesmo assim"
    );
    return 0;
  }
}
