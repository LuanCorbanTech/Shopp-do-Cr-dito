import { logger } from "@plataforma-ofertas/shared";
import {
  nextAttemptDate,
  hasExceededMaxAttempts,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
  DEFAULT_MAX_TENTATIVAS,
  type MargemFactaOnlinePort,
  type IntegrationConfigPort,
} from "@plataforma-ofertas/domain";
import { FactaMargemError, type FactaMargemConfig } from "../fornecedores/facta-margem";

// Worker 0-B — Consulta ONLINE de margem Facta (04/09, 2ª etapa) — só
// processa ofertas que a consulta OFFLINE (worker0) deixou em
// AGUARDANDO_CONSULTA_ONLINE (Facta não tinha histórico offline pra esse
// CPF). 2 fases, cada ciclo processa as duas:
//
//   Fase 1 (registrar autorização): AGUARDANDO_CONSULTA_ONLINE ->
//     registra autorização (sem link, pedido explícito) ->
//     AGUARDANDO_RESULTADO_ONLINE_FACTA (com uma janela de espera antes de
//     poder checar)
//   Fase 2 (checar resultado): AGUARDANDO_RESULTADO_ONLINE_FACTA, só
//     quando a janela já passou -> consulta os dados de verdade:
//       margem > 0  -> MARGEM_APROVADA
//       margem <= 0 -> MARGEM_NEGATIVA
//       "ainda processando" (não é erro) -> agenda nova checagem
//       esgotou tentativas / erro terminal -> "falha aberta" (MARGEM_APROVADA,
//         mesmo espírito da consulta offline — nunca trava o lead pra
//         sempre por um problema nosso ou da Facta)
//
// IMPORTANTE: os 2 endpoints usados aqui (cadastrar-autorizacao-consulta e
// consulta-dados-trabalhador) NÃO estão no manual oficial da Facta — foram
// fornecidos direto no chat, sem documentação formal dos possíveis
// retornos. Por isso guarda a resposta bruta inteira em dadosFactaOnline
// sempre (sucesso ou erro), pra dar pra conferir/ajustar se algum caso não
// prVISTO aparecer na prática.

export interface FactaOnlineService {
  gerarToken(config: FactaMargemConfig): Promise<{ token: string; expiraEm: Date }>;
  cadastrarAutorizacao(
    config: FactaMargemConfig,
    token: string,
    params: {
      averbador: string;
      nome: string;
      cpf: string;
      celular: string;
      localizacaoIp: string;
      localizacaoAutorizacao: string;
    }
  ): Promise<{ jaAutorizado: boolean; respostaBruta: unknown }>;
  consultarDados(
    config: FactaMargemConfig,
    token: string,
    cpf: string
  ): Promise<{ dados: Record<string, unknown> | null; aindaProcessando: boolean; respostaBruta: unknown }>;
}

export interface RunMargemFactaOnlineWorkerOnceParams {
  port: MargemFactaOnlinePort;
  configPort: IntegrationConfigPort;
  factaService: FactaOnlineService;
  /** Formato "(00) 00000-0000" — telefones crus (11 dígitos, sem +55) viram esse formato automaticamente. */
  formatarCelular?: (telefone: string) => string;
  batchSize?: number;
  /** Quanto esperar depois de registrar a autorização antes da 1ª checagem (padrão: 60s). */
  esperaAposRegistrarMs?: number;
  now?: Date;
}

export interface RunMargemFactaOnlineWorkerOnceResultado {
  autorizacoesRegistradas: number;
  erroRegistrar: number;
  aprovadas: number;
  negativas: number;
  aindaProcessando: number;
  falhasAbertas: number;
}

function paraNumero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

// (00) 00000-0000 — mesmo formato do exemplo de cURL fornecido. Assume
// telefone cru de 10 ou 11 dígitos (DDD + número, sem DDI), igual ao
// formato já usado em todo o resto do sistema.
export function formatarCelularFacta(telefone: string): string {
  const digitos = telefone.replace(/\D/g, "");
  const semDDI = digitos.length >= 12 && digitos.startsWith("55") ? digitos.slice(2) : digitos;
  if (semDDI.length < 10) return telefone; // não reconhecido -- devolve como veio, não trava o fluxo
  const ddd = semDDI.slice(0, 2);
  const resto = semDDI.slice(2);
  if (resto.length === 9) return `(${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`;
  return `(${ddd}) ${resto.slice(0, 4)}-${resto.slice(4)}`;
}

export async function runMargemFactaOnlineWorkerOnce(
  params: RunMargemFactaOnlineWorkerOnceParams
): Promise<RunMargemFactaOnlineWorkerOnceResultado> {
  const {
    port,
    configPort,
    factaService,
    formatarCelular = formatarCelularFacta,
    batchSize = 1,
    esperaAposRegistrarMs = 60_000,
    now = new Date(),
  } = params;

  const resultado: RunMargemFactaOnlineWorkerOnceResultado = {
    autorizacoesRegistradas: 0,
    erroRegistrar: 0,
    aprovadas: 0,
    negativas: 0,
    aindaProcessando: 0,
    falhasAbertas: 0,
  };

  const config = await configPort.getConfig("FACTA_MARGEM_CREDENCIAIS");
  // ativoOnline (11/09): interruptor PRÓPRIO da consulta online, independente
  // do da offline (pedido explícito — poder desligar só uma das duas). Quando
  // ainda não foi salvo explicitamente (config antiga, de antes dessa
  // mudança), cai no valor do interruptor geral — não muda o comportamento
  // de quem nunca mexeu nesse campo novo.
  const valorConfig = (config?.valor ?? {}) as { ativoOnline?: boolean };
  const ativoOnline = typeof valorConfig.ativoOnline === "boolean" ? valorConfig.ativoOnline : (config?.ativo ?? false);
  if (!ativoOnline) return resultado;

  const usuario = String(config?.valor.usuario ?? "");
  const senha = String(config?.valor.senha ?? "");
  const averbador = String(config?.valor.averbadorOnline ?? "10010");
  const localizacaoIp = String(config?.valor.localizacaoIpOnline ?? "");
  const localizacaoAutorizacao = String(config?.valor.localizacaoAutorizacaoOnline ?? "");
  const maxTentativas = Number(config?.valor.maxTentativasOnline ?? DEFAULT_MAX_TENTATIVAS);
  const schedule = Array.isArray(config?.valor.backoffSecondsScheduleOnline)
    ? (config!.valor.backoffSecondsScheduleOnline as number[])
    : DEFAULT_BACKOFF_SCHEDULE_SECONDS;

  if (!usuario || !senha) return resultado; // sem credencial -- nem tenta (a offline já loga o erro alto)

  const onlineConfig: FactaMargemConfig = { usuario, senha, baseUrl: config?.valor.baseUrlOnline as string | undefined };

  async function obterToken(): Promise<string> {
    const cache = await port.buscarTokenOnlineFactaCache();
    if (cache && cache.expiraEm.getTime() > now.getTime() + 5_000) return cache.token;
    const gerado = await factaService.gerarToken(onlineConfig);
    await port.salvarTokenOnlineFactaCache(gerado.token, gerado.expiraEm);
    return gerado.token;
  }

  // ---- Fase 1: registrar autorização ----
  const paraRegistrar = await port.claimOffersParaRegistrarAutorizacaoOnline(batchSize);
  for (const oferta of paraRegistrar) {
    const tentativa = oferta.tentativasOnlineFacta + 1;
    try {
      if (!oferta.cpf || !oferta.telefoneOriginal) {
        // Sem CPF ou sem telefone -- não tem como registrar autorização
        // (celular é obrigatório). Falha aberta direto, sem tentar de novo.
        await port.marcarFalhaAbertaOnline(oferta.id);
        resultado.falhasAbertas += 1;
        continue;
      }
      const token = await obterToken();
      const registro = await factaService.cadastrarAutorizacao(onlineConfig, token, {
        averbador,
        nome: oferta.nome ?? "",
        cpf: oferta.cpf,
        celular: formatarCelular(oferta.telefoneOriginal),
        localizacaoIp,
        localizacaoAutorizacao,
      });
      // "jaAutorizado" (mensagem "não necessita de autorização") -- pode
      // checar quase na hora, sem esperar a janela cheia; mesmo assim dá
      // uma folga mínima pra não martelar em sequência.
      const espera = registro.jaAutorizado ? 5_000 : esperaAposRegistrarMs;
      await port.marcarAutorizacaoOnlineRegistrada(oferta.id, registro.respostaBruta, new Date(now.getTime() + espera));
      resultado.autorizacoesRegistradas += 1;
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      const cancelar = hasExceededMaxAttempts(tentativa, maxTentativas);
      if (cancelar) {
        await port.marcarFalhaAbertaOnline(oferta.id);
        resultado.falhasAbertas += 1;
        logger.error({ offerId: oferta.id, tentativa, error: mensagem }, "Registro de autorização online Facta falhou repetidamente — liberado sem checar (falha aberta).");
      } else {
        await port.marcarErroRegistrarAutorizacaoOnline(oferta.id, { erro: mensagem, tentativa, proximaTentativaEm: nextAttemptDate(tentativa, now, schedule) });
        resultado.erroRegistrar += 1;
        logger.warn({ offerId: oferta.id, tentativa, error: mensagem }, "Falha ao registrar autorização online na Facta");
      }
    }
  }

  // ---- Fase 2: checar resultado ----
  const paraChecar = await port.claimOffersParaVerificarResultadoOnline(batchSize, now);
  for (const oferta of paraChecar) {
    const tentativa = oferta.tentativasOnlineFacta + 1;
    try {
      if (!oferta.cpf) {
        await port.marcarFalhaAbertaOnline(oferta.id);
        resultado.falhasAbertas += 1;
        continue;
      }
      const token = await obterToken();
      const consulta = await factaService.consultarDados(onlineConfig, token, oferta.cpf);

      if (consulta.aindaProcessando) {
        const cancelar = hasExceededMaxAttempts(tentativa, maxTentativas);
        if (cancelar) {
          await port.marcarFalhaAbertaOnline(oferta.id);
          resultado.falhasAbertas += 1;
          logger.error({ offerId: oferta.id, tentativa }, "Consulta online Facta nunca processou (esgotou tentativas) — liberado sem checar (falha aberta).");
        } else {
          await port.marcarAindaProcessandoOnline(oferta.id, nextAttemptDate(tentativa, now, schedule), tentativa);
          resultado.aindaProcessando += 1;
        }
        continue;
      }

      const valorMargem = consulta.dados ? paraNumero(consulta.dados.valorMargemDisponivel) : null;
      if (valorMargem !== null && valorMargem > 0) {
        await port.marcarMargemAprovadaOnline(oferta.id, { valorMargemDisponivel: valorMargem, dadosCompletos: consulta.dados });
        resultado.aprovadas += 1;
      } else {
        await port.marcarMargemNegativaOnline(oferta.id, { valorMargemDisponivel: valorMargem ?? 0, dadosCompletos: consulta.dados });
        resultado.negativas += 1;
      }
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      const cancelar = hasExceededMaxAttempts(tentativa, maxTentativas);
      if (cancelar) {
        await port.marcarFalhaAbertaOnline(oferta.id);
        resultado.falhasAbertas += 1;
        logger.error({ offerId: oferta.id, tentativa, error: mensagem }, "Consulta online Facta falhou repetidamente — liberado sem checar (falha aberta).");
      } else {
        const rateLimited = error instanceof FactaMargemError && error.rateLimited;
        await port.marcarAindaProcessandoOnline(oferta.id, nextAttemptDate(tentativa, now, schedule), tentativa);
        resultado.aindaProcessando += 1;
        logger.warn({ offerId: oferta.id, tentativa, rateLimited, error: mensagem }, "Falha na consulta online Facta — tenta de novo depois");
      }
    }
  }

  return resultado;
}
