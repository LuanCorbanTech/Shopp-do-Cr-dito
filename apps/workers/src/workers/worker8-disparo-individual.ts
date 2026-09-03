import { randomUUID } from "node:crypto";
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
// Cada endpoint tem um "modelo" — o formato de corpo/cabeçalhos que o
// sistema do outro lado espera receber. Hoje: "hyperflow" (formato
// original) e "ararahq" (novo — corpo simples {phone, name} + autenticação
// Bearer + Idempotency-Key). Pensado pra crescer: adicionar um modelo novo
// no futuro é só um novo "case" na função montarRequisicao, sem mexer no
// resto do worker.
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
  // Grava cada tentativa (sucesso ou falha) pra ficar visível na tela de
  // detalhes da oferta — nunca lança exceção nem trava o envio em si (ver
  // uso em enviarParaEndpoint: chamado depois de decidir o resultado, e
  // qualquer falha AQUI só vira um aviso no log, não desfaz o envio).
  registrarTentativaDisparoIndividual(dados: {
    offerId: string;
    endpointId: string;
    endpointUrl: string;
    modelo: string;
    sucesso: boolean;
    httpStatus: number | null;
    timeout: boolean;
    erro: string | null;
    payloadEnviado: unknown;
  }): Promise<void>;
}

export type DisparoIndividualModelo = "hyperflow" | "ararahq";

export interface DisparoIndividualEndpoint {
  id: string;
  url: string;
  ativo: boolean;
  modelo: DisparoIndividualModelo;
}

export interface RunDisparoIndividualWorkerOnceParams {
  ativo: boolean;
  endpoints?: DisparoIndividualEndpoint[] | null;
  port: DisparoIndividualPort;
  /** Chave da Ararahq (Bearer token) — uma só, compartilhada por todos os endpoints desse modelo (confirmado com o cliente: não é por endpoint). Só é usada quando algum endpoint tem modelo "ararahq". */
  ararahqApiKey?: string | null;
  /** Injeção do fetch — só pra testar sem rede de verdade; em produção usa o fetch global. */
  fetchImpl?: typeof fetch;
  /** Tempo máximo de espera por endpoint, em ms — padrão 10s. Configurável só pra facilitar teste (produção sempre usa o padrão). */
  timeoutMsPorEndpoint?: number;
  /** Gerador do Idempotency-Key da Ararahq — só pra facilitar teste (produção sempre usa um UUID de verdade, aleatório, nunca repete). */
  gerarIdempotencyKey?: () => string;
}

// Mesmos campos do GET /api/v1/leads/aguardando-disparo (um objeto, não um
// array com "leads" — cada endpoint recebe sempre 1 por vez). Formato do
// modelo "hyperflow".
export interface DisparoIndividualBodyHyperflow {
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

// Formato do modelo "ararahq" — bem mais simples, confirmado com o cliente:
// só telefone (com "+" na frente, formato internacional) e nome.
export interface DisparoIndividualBodyAraraHQ {
  phone: string | null;
  name: string | null;
}

export function montarDisparoIndividualBody(o: OfferSnapshot): DisparoIndividualBodyHyperflow {
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

// BUG REAL corrigido em 04/09 — só adicionava o "+" na frente, mas nunca
// verificava se faltava o DDI (55). telefoneValidado normalmente vem SEM
// DDI (ex.: "45999701663", DDD 45 + número — o mesmo formato usado sempre
// pra Hyperflow), e mandar isso direto com "+" na frente vira
// "+45999701663" — que é interpretado como um número da DINAMARCA (+45 é
// o código do país deles), não Brasil com DDD 45! Detectado porque o
// parceiro reportou números chegando errados do lado da Ararahq.
function formatarTelefoneInternacionalAraraHQ(telefone: string): string {
  if (telefone.startsWith("+")) return telefone;
  const digitos = telefone.replace(/\D/g, "");
  const comDDI = digitos.length >= 12 && digitos.startsWith("55") ? digitos : `55${digitos}`;
  return `+${comDDI}`;
}

export function montarDisparoIndividualBodyAraraHQ(o: OfferSnapshot): DisparoIndividualBodyAraraHQ {
  const telefone = o.telefoneValidado;
  return {
    // A Ararahq espera formato internacional com "+" na frente e o DDI do
    // Brasil incluso (ex.: "+5545999701663").
    phone: telefone ? formatarTelefoneInternacionalAraraHQ(telefone) : null,
    name: o.nome,
  };
}

interface RequisicaoMontada {
  body: unknown;
  headers: Record<string, string>;
}

function montarRequisicao(
  endpoint: DisparoIndividualEndpoint,
  lead: OfferSnapshot,
  ararahqApiKey: string | null | undefined,
  gerarIdempotencyKey: () => string
): RequisicaoMontada {
  if (endpoint.modelo === "ararahq") {
    return {
      body: montarDisparoIndividualBodyAraraHQ(lead),
      headers: {
        "Content-Type": "application/json",
        // Confirmado com o dev da Ararahq: precisa ser uma chave aleatória
        // que nunca se repete — gerada nova a cada requisição, não baseada
        // no id do lead nem em nada fixo.
        "Idempotency-Key": gerarIdempotencyKey(),
        Authorization: `Bearer ${ararahqApiKey ?? ""}`,
      },
    };
  }
  // "hyperflow" (padrão) — formato original, sem mudança nenhuma.
  return {
    body: montarDisparoIndividualBody(lead),
    headers: { "Content-Type": "application/json" },
  };
}

// Tempo máximo de espera por UMA chamada (padrão, configurável via
// timeoutMsPorEndpoint) — sem isso, um endpoint que trava (nunca responde,
// sem erro nem sucesso) prenderia o ciclo inteiro pra sempre, mesmo com só
// 1 endpoint problemático entre vários bons. Com o timeout, essa chamada
// específica falha depois do tempo configurado (contada como falha normal
// — cai no mesmo tratamento de erro), e o ciclo consegue terminar e seguir
// pro próximo normalmente.

// Grava a tentativa no banco (pra aparecer na tela da oferta) sem nunca
// travar o worker por causa disso — se a própria gravação falhar (banco
// fora do ar num instante ruim, etc.), isso vira só um aviso no log, nunca
// derruba o envio em si nem o resultado que já foi decidido.
async function registrarTentativaComSeguranca(
  port: DisparoIndividualPort,
  dados: Parameters<DisparoIndividualPort["registrarTentativaDisparoIndividual"]>[0]
): Promise<void> {
  try {
    await port.registrarTentativaDisparoIndividual(dados);
  } catch (error) {
    logger.warn({ error, offerId: dados.offerId, endpointId: dados.endpointId }, "Falha ao registrar a tentativa de disparo individual (não afeta o envio em si)");
  }
}

async function enviarParaEndpoint(
  endpoint: DisparoIndividualEndpoint,
  lead: OfferSnapshot,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  ararahqApiKey: string | null | undefined,
  gerarIdempotencyKey: () => string,
  port: DisparoIndividualPort
): Promise<boolean> {
  const { body, headers } = montarRequisicao(endpoint, lead, ararahqApiKey, gerarIdempotencyKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resposta = await fetchImpl(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resposta.ok) {
      logger.error(
        { endpointId: endpoint.id, endpointUrl: endpoint.url, modelo: endpoint.modelo, status: resposta.status, offerId: lead.id },
        "Endpoint do disparo individual respondeu com erro — a oferta já ficou marcada como DISPARO_CONSULTADO mesmo assim"
      );
      await registrarTentativaComSeguranca(port, {
        offerId: lead.id, endpointId: endpoint.id, endpointUrl: endpoint.url, modelo: endpoint.modelo,
        sucesso: false, httpStatus: resposta.status, timeout: false, erro: null, payloadEnviado: body,
      });
      return false;
    }
    logger.info(
      { endpointId: endpoint.id, endpointUrl: endpoint.url, modelo: endpoint.modelo, offerId: lead.id },
      "Lead individual enviado"
    );
    await registrarTentativaComSeguranca(port, {
      offerId: lead.id, endpointId: endpoint.id, endpointUrl: endpoint.url, modelo: endpoint.modelo,
      sucesso: true, httpStatus: resposta.status, timeout: false, erro: null, payloadEnviado: body,
    });
    return true;
  } catch (error) {
    const foiTimeout = error instanceof Error && error.name === "AbortError";
    logger.error(
      { endpointId: endpoint.id, endpointUrl: endpoint.url, modelo: endpoint.modelo, error, offerId: lead.id, timeout: foiTimeout },
      foiTimeout
        ? `Endpoint não respondeu em ${timeoutMs / 1000}s (timeout) — a oferta já ficou marcada como DISPARO_CONSULTADO mesmo assim`
        : "Falha ao enviar o lead individual — a oferta já ficou marcada como DISPARO_CONSULTADO mesmo assim"
    );
    await registrarTentativaComSeguranca(port, {
      offerId: lead.id, endpointId: endpoint.id, endpointUrl: endpoint.url, modelo: endpoint.modelo,
      sucesso: false, httpStatus: null, timeout: foiTimeout, erro: error instanceof Error ? error.message : String(error), payloadEnviado: body,
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDisparoIndividualWorkerOnce(params: RunDisparoIndividualWorkerOnceParams): Promise<number> {
  const {
    ativo,
    endpoints,
    port,
    ararahqApiKey,
    fetchImpl = fetch,
    timeoutMsPorEndpoint = 10_000,
    gerarIdempotencyKey = randomUUID,
  } = params;

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
    pares.map(({ lead, endpoint }) =>
      enviarParaEndpoint(endpoint, lead, fetchImpl, timeoutMsPorEndpoint, ararahqApiKey, gerarIdempotencyKey, port)
    )
  );

  return resultados.filter((r) => r.status === "fulfilled" && r.value === true).length;
}
