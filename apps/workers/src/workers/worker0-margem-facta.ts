import { logger } from "@plataforma-ofertas/shared";
import {
  nextAttemptDate,
  hasExceededMaxAttempts,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
  DEFAULT_MAX_TENTATIVAS,
  type MargemFactaPort,
  type IntegrationConfigPort,
} from "@plataforma-ofertas/domain";
import { FactaMargemError, type FactaMargemConfig } from "../fornecedores/facta-margem";

// Worker 0 — Consulta de margem Facta (04/09, pedido explícito) — nova
// PRIMEIRA etapa do funil, antes de tudo o que já existia (inclusive antes
// do Worker 1/Lemit). Pega a oferta assim que chega (RECEBIDO), consulta a
// base offline da Facta por CPF, e decide:
//
//   valorMargemDisponivel > 0  -> MARGEM_APROVADA (segue o fluxo de sempre —
//                                 Worker 1 agora reivindica ofertas nesse
//                                 status, não mais RECEBIDO diretamente)
//   valorMargemDisponivel <= 0 -> MARGEM_NEGATIVA (processo encerra aqui)
//   "Nenhum dado encontrado"   -> AGUARDANDO_CONSULTA_ONLINE (2ª etapa ainda
//                                 não implementada — fica esperando)
//   erro transitório (rate limit, timeout, rede) -> agenda nova tentativa
//   sem CPF, ou desativado no painel, ou esgotou as tentativas -> passa
//                                 direto (MARGEM_APROVADA, "falha aberta" —
//                                 não bloqueia o funil por um problema
//                                 nosso/da Facta, só não teve como checar)
//
// IMPORTANTE — limite de taxa da própria Facta: só pode consultar
// /clt/base-offline 1 vez a cada 3 segundos. Por isso esse worker processa
// NO MÁXIMO 1 oferta por ciclo (batchSize sempre 1 na prática — ver
// index.ts, que chama esse worker num intervalo de ciclo que já respeita
// essa folga), mesmo que o parâmetro permita mais.
//
// EXCEÇÃO (11/09) — integração DESATIVADA no painel: nesse caso não tem
// NENHUMA chamada de rede pra Facta (é só um "aprova direto", loop local no
// banco), então o limite de 3s não se aplica e não faz sentido processar só
// 1 por ciclo — isso deixaria RECEBIDO acumulando indefinidamente sempre
// que a Facta estiver desligada e o volume de leads for maior que ~1 a
// cada intervalo do ciclo. Por isso, quando desativada, usa um lote bem
// maior (batchSizeDesativado, ver abaixo) pra escoar a fila rápido.

// Serviço injetado (não importa gerarTokenFacta/consultarBaseOfflineFacta
// direto aqui) — mesmo espírito do "LimitLookup" no worker1-limit.ts:
// mantém esse worker testável com fakes, sem precisar de rede de verdade
// nem duplicar a config de conexão.
export interface FactaMargemService {
  gerarToken(config: FactaMargemConfig): Promise<{ token: string; expiraEm: Date }>;
  consultarCpf(
    config: FactaMargemConfig,
    token: string,
    cpf: string
  ): Promise<{ dados: Record<string, unknown> | null; respostaBruta: unknown }>;
}

export interface RunMargemFactaWorkerOnceParams {
  port: MargemFactaPort;
  configPort: IntegrationConfigPort;
  factaService: FactaMargemService;
  /** Usado só quando a integração está ATIVA (respeita o limite de 3s da Facta). Padrão: 1. */
  batchSize?: number;
  /** Usado só quando a integração está DESATIVADA no painel (sem chamada de rede, não tem limite de taxa). Padrão: 300. */
  batchSizeDesativado?: number;
  now?: Date;
}

export interface RunMargemFactaWorkerOnceResultado {
  aprovadas: number;
  negativas: number;
  aguardandoOnline: number;
  erros: number;
}

function paraNumero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

export async function runMargemFactaWorkerOnce(
  params: RunMargemFactaWorkerOnceParams
): Promise<RunMargemFactaWorkerOnceResultado> {
  const { port, configPort, factaService, batchSize = 1, batchSizeDesativado = 300, now = new Date() } = params;

  let aprovadas = 0;
  let negativas = 0;
  let aguardandoOnline = 0;
  let erros = 0;

  const config = await configPort.getConfig("FACTA_MARGEM_CREDENCIAIS");
  const ativo = config?.ativo ?? false;
  const usuario = String(config?.valor.usuario ?? "");
  const senha = String(config?.valor.senha ?? "");
  const maxTentativas = Number(config?.valor.maxTentativas ?? DEFAULT_MAX_TENTATIVAS);
  const schedule = Array.isArray(config?.valor.backoffSecondsSchedule)
    ? (config!.valor.backoffSecondsSchedule as number[])
    : DEFAULT_BACKOFF_SCHEDULE_SECONDS;

  // Desativada -> não tem limite de 3s da Facta pra respeitar (nenhuma
  // chamada de rede acontece nesse ramo), então processa um lote bem maior
  // por ciclo pra não deixar RECEBIDO empilhar enquanto a integração
  // estiver desligada.
  const batchEfetivo = ativo ? batchSize : batchSizeDesativado;
  const ofertas = await port.claimOffersParaMargem(batchEfetivo, now);
  if (ofertas.length === 0) return { aprovadas, negativas, aguardandoOnline, erros };

  // Desativado no painel — passa direto pra todo mundo desse ciclo, sem
  // nenhuma chamada à Facta (mesmo espírito do "Lemit desativada": nunca
  // trava a oferta por uma integração que o usuário escolheu não usar).
  if (!ativo) {
    for (const oferta of ofertas) {
      await port.marcarMargemAprovada(oferta.id, { valorMargemDisponivel: null, dadosCompletos: null });
      aprovadas += 1;
    }
    logger.info({ quantidade: ofertas.length }, "Consulta de margem Facta ignorada: integração desativada no painel.");
    return { aprovadas, negativas, aguardandoOnline, erros };
  }

  if (!usuario || !senha) {
    // Configurado como "ativo" mas sem credencial — não é culpa do lead,
    // não trava o funil; só loga bem alto pra alguém notar e corrigir.
    for (const oferta of ofertas) {
      await port.marcarMargemAprovada(oferta.id, { valorMargemDisponivel: null, dadosCompletos: null });
      aprovadas += 1;
    }
    logger.error("Consulta de margem Facta ATIVADA mas sem usuário/senha configurados (painel Integrações) — ofertas liberadas sem checar, corrija a credencial.");
    return { aprovadas, negativas, aguardandoOnline, erros };
  }

  const factaConfig: FactaMargemConfig = { usuario, senha, baseUrl: config?.valor.baseUrl as string | undefined };

  // Token: reaproveita o do cache se ainda válido (dura 1h na Facta); só
  // gera um novo quando expirado ou ausente — evita gastar uma chamada de
  // token a cada CPF consultado.
  async function obterTokenValido(): Promise<string> {
    const cache = await port.buscarTokenFactaCache();
    if (cache && cache.expiraEm.getTime() > now.getTime() + 5_000) {
      return cache.token;
    }
    const gerado = await factaService.gerarToken(factaConfig);
    await port.salvarTokenFactaCache(gerado.token, gerado.expiraEm);
    return gerado.token;
  }

  for (const oferta of ofertas) {
    if (!oferta.cpf) {
      await port.marcarMargemAprovada(oferta.id, { valorMargemDisponivel: null, dadosCompletos: null });
      aprovadas += 1;
      logger.info({ offerId: oferta.id }, "Consulta de margem Facta ignorada: lead sem CPF, liberado sem checar.");
      continue;
    }

    const tentativa = oferta.tentativasMargemFacta + 1;
    try {
      const token = await obterTokenValido();
      const resultado = await factaService.consultarCpf(factaConfig, token, oferta.cpf);

      if (resultado.dados === null) {
        await port.marcarAguardandoConsultaOnline(oferta.id, resultado.respostaBruta);
        aguardandoOnline += 1;
        continue;
      }

      const valorMargem = paraNumero(resultado.dados.valorMargemDisponivel);
      if (valorMargem !== null && valorMargem > 0) {
        await port.marcarMargemAprovada(oferta.id, { valorMargemDisponivel: valorMargem, dadosCompletos: resultado.dados });
        aprovadas += 1;
      } else {
        await port.marcarMargemNegativa(oferta.id, { valorMargemDisponivel: valorMargem ?? 0, dadosCompletos: resultado.dados });
        negativas += 1;
        logger.info({ offerId: oferta.id, valorMargem }, "Margem indisponível (Facta) — processo encerrado.");
      }
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      const cancelar = hasExceededMaxAttempts(tentativa, maxTentativas);

      if (cancelar) {
        // Esgotou as tentativas — "falha aberta": libera pro fluxo normal em
        // vez de deixar o lead preso pra sempre por causa de uma
        // instabilidade da Facta (ou nossa). Fica registrado no log e nos
        // dados salvos (dadosCompletos null + erro só no log) que essa
        // oferta especificamente NÃO foi checada de verdade.
        await port.marcarMargemAprovada(oferta.id, { valorMargemDisponivel: null, dadosCompletos: null });
        aprovadas += 1;
        logger.error(
          { offerId: oferta.id, tentativa, error: mensagem },
          "Consulta de margem Facta falhou repetidamente — liberado sem checar (falha aberta) após esgotar tentativas."
        );
        continue;
      }

      await port.marcarErroMargem(oferta.id, {
        erro: mensagem,
        tentativa,
        proximaTentativaEm: nextAttemptDate(tentativa, now, schedule),
      });
      erros += 1;
      const rateLimited = error instanceof FactaMargemError && error.rateLimited;
      logger.warn({ offerId: oferta.id, tentativa, rateLimited, error: mensagem }, "Falha na consulta de margem Facta");
    }
  }

  return { aprovadas, negativas, aguardandoOnline, erros };
}
