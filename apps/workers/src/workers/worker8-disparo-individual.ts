import { logger } from "@plataforma-ofertas/shared";
import type { OfferSnapshot } from "@plataforma-ofertas/domain";

// Worker 8 — Disparo individual (push). Diferente do endpoint GET
// /api/v1/leads/aguardando-disparo (onde um sistema externo é quem puxa,
// no ritmo dele), aqui é o CONTRÁRIO: este worker que EMPURRA.
//
// Suporta MÚLTIPLOS endpoints cadastrados no painel ("Integrações") — a
// cada ciclo, pega até 1 lead PRA CADA endpoint ATIVO e manda todos ao
// mesmo tempo (em paralelo, um não espera o outro). Pedido explícito: cada
// endpoint individual continua recebendo só 1 lead por ciclo (nunca um
// array) — a diferença é que agora vários "1 por ciclo" acontecem
// simultaneamente, um por URL, multiplicando o throughput total pelo
// número de endpoints ativos sem precisar reduzir o intervalo do ciclo.
// Motivo original do pedido: a Hyperflow aceita até 1000 disparos/min, e
// com 1 endpoint só o sistema ficava limitado a ~60/min.
//
// Reaproveita a MESMA claim atômica do endpoint GET
// (claimOffersAguardandoDisparo — UPDATE...RETURNING com SKIP LOCKED): cada
// oferta já sai marcada como DISPARO_CONSULTADO no instante em que é
// escolhida, mesmo antes do POST ser tentado. Isso é intencional e é o
// MESMO risco que o endpoint GET já tinha desde sempre: se o POST falhar
// (endpoint fora do ar, timeout), a oferta já ficou marcada como
// "consultada" mesmo assim — ela não volta pra fila sozinha. Documentado
// aqui de propósito pra quem for mexer depois não achar que é bug novo.
//
// Se um endpoint falhar num ciclo, os outros continuam normalmente — cada
// envio é independente (Promise.allSettled, não Promise.all).

export interface DisparoIndividualPort {
  claimOffersAguardandoDisparo(limit: number): Promise<OfferSnapshot[]>;
}

export interface DisparoIndividualEndpoint {
  id: string;
  url: string;
  ativo: boolean;
}

export interface RunDisparoIndividualWorkerOnceParams {
  ativo: boolean;
  endpoints?: DisparoIndividualEndpoint[] | null;
  port: DisparoIndividualPort;
  /** Injeção do fetch — só pra testar sem rede de verdade; em produção usa o fetch global. */
  fetchImpl?: typeof fetch;
}

// Mesmos campos do GET /api/v1/leads/aguardando-disparo (um objeto, não um
// array com "leads" — cada endpoint recebe sempre 1 por vez).
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

async function enviarParaEndpoint(
  endpoint: DisparoIndividualEndpoint,
  lead: OfferSnapshot,
  fetchImpl: typeof fetch
): Promise<boolean> {
  const body = montarDisparoIndividualBody(lead);
  try {
    const resposta = await fetchImpl(endpoint.url, {
      method: "POST",
      // Só este header, mesmo padrão do relatório periódico — nada de
      // Authorization aqui (o endpoint é do próprio usuário).
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resposta.ok) {
      logger.error(
        { endpointId: endpoint.id, endpointUrl: endpoint.url, status: resposta.status, offerId: lead.id },
        "Endpoint do disparo individual respondeu com erro — a oferta já ficou marcada como DISPARO_CONSULTADO mesmo assim"
      );
      return false;
    }
    logger.info({ endpointId: endpoint.id, endpointUrl: endpoint.url, offerId: lead.id }, "Lead individual enviado");
    return true;
  } catch (error) {
    logger.error(
      { endpointId: endpoint.id, endpointUrl: endpoint.url, error, offerId: lead.id },
      "Falha ao enviar o lead individual — a oferta já ficou marcada como DISPARO_CONSULTADO mesmo assim"
    );
    return false;
  }
}

export async function runDisparoIndividualWorkerOnce(params: RunDisparoIndividualWorkerOnceParams): Promise<number> {
  const { ativo, endpoints, port, fetchImpl = fetch } = params;

  if (!ativo) return 0;
  const endpointsAtivos = (endpoints ?? []).filter((e) => e.ativo && e.url);
  if (endpointsAtivos.length === 0) {
    logger.warn("Disparo individual ativado mas sem nenhum endpoint ativo cadastrado no painel — ciclo ignorado");
    return 0;
  }

  // Pega até 1 lead PRA CADA endpoint ativo — se tiver menos gente esperando
  // que endpoints, manda só pros primeiros (na ordem em que os leads mais
  // antigos foram claimados), o resto do envio simplesmente não acontece
  // nesse ciclo específico (sem erro nenhum, só não tinha lead suficiente).
  const ofertas = await port.claimOffersAguardandoDisparo(endpointsAtivos.length);
  if (ofertas.length === 0) return 0; // ninguém esperando neste ciclo

  const pares = ofertas.map((lead, i) => ({ lead, endpoint: endpointsAtivos[i] }));
  const resultados = await Promise.allSettled(
    pares.map(({ lead, endpoint }) => enviarParaEndpoint(endpoint, lead, fetchImpl))
  );

  return resultados.filter((r) => r.status === "fulfilled" && r.value === true).length;
}
