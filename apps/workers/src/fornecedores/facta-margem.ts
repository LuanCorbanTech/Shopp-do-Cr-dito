// Cliente da API "Consulta Dados CLT - OFFLINE" da Facta (04/09).
// Documentação: Manual-do-WebService-FACTA-v2.0-BASE-OFFLINE-CLT.pdf
//
// Contrato real (2 endpoints):
//   1) GET /gera-token
//      Header: Authorization: Basic <base64(usuario:senha)>
//      Resposta: { erro: false, token, expira: "dd/mm/aaaa HH:MM:SS" }
//              | { erro: true, mensagem: "Usuário ou senha inválida" }
//   2) GET /clt/base-offline?cpf=00000000000
//      Header: Authorization: Bearer <token>
//      IMPORTANTE (regra da própria Facta): intervalo mínimo de 3s entre
//      chamadas desse endpoint — respeitado aqui fora, no worker (ver
//      worker0-margem-facta.ts), não neste arquivo.
//      Resposta:
//        { erro: false, mensagem, dados: [{ valorMargemDisponivel, ... }] }
//      | { erro: true, mensagem: "Consulta de base offline indisponível, volte em 3 segundos" }
//      | { erro: true, mensagem: "Nenhum dado encontrado!", dados: [] }
//      | { erro: true, mensagem: "{cpf} deve seguir o modelo 999.999.999-99; " }
//
// O token dura 1h e é reaproveitável — o CACHE dele (pra não gerar um novo
// a cada CPF consultado) é responsabilidade de QUEM CHAMA este módulo
// (worker0-margem-facta.ts guarda token+validade no banco), não deste
// cliente, que só sabe conversar com a API em si.

export interface FactaMargemConfig {
  usuario: string;
  senha: string;
  /** Raiz do serviço. Produção por padrão — Facta não fornece homologação pra esse cliente hoje. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface FactaTokenResult {
  token: string;
  /** Data/hora de expiração, já convertida pra Date (o formato da Facta é "dd/mm/aaaa HH:MM:SS"). */
  expiraEm: Date;
}

export class FactaMargemError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly respostaBruta?: unknown,
    /** true quando a mensagem é literalmente o aviso de limite de 3s — quem chama sabe que deve tentar de novo, não é erro terminal. */
    public readonly rateLimited: boolean = false
  ) {
    super(message);
    this.name = "FactaMargemError";
  }
}

const FACTA_DEFAULT_BASE_URL = "https://cltoff.facta.com.br";

function parseDataFacta(valor: string): Date {
  // Formato da Facta: "21/10/2025 16:16:25" (dia/mês/ano hora:min:seg).
  const m = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return new Date(0); // formato inesperado -> trata como já expirado, força gerar um novo
  const [, dia, mes, ano, hora, min, seg] = m;
  return new Date(Number(ano), Number(mes) - 1, Number(dia), Number(hora), Number(min), Number(seg));
}

export async function gerarTokenFacta(config: FactaMargemConfig): Promise<FactaTokenResult> {
  const baseUrl = (config.baseUrl || FACTA_DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? 10_000;
  const basic = Buffer.from(`${config.usuario}:${config.senha}`).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/gera-token`, {
      method: "GET",
      headers: { Authorization: `Basic ${basic}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as {
      erro?: boolean;
      mensagem?: string;
      token?: string;
      expira?: string;
    } | null;
    if (!response.ok || !body || body.erro) {
      throw new FactaMargemError(
        (body && body.mensagem) || `Facta respondeu ${response.status} ao gerar token`,
        response.status,
        body
      );
    }
    return { token: body.token as string, expiraEm: parseDataFacta(body.expira as string) };
  } finally {
    clearTimeout(timeout);
  }
}

export interface FactaConsultaOfflineResultado {
  /** null quando "Nenhum dado encontrado" — CPF sem histórico na base offline da Facta (não é erro). */
  dados: Record<string, unknown> | null;
  respostaBruta: unknown;
}


export async function consultarBaseOfflineFacta(
  config: FactaMargemConfig,
  token: string,
  cpf: string
): Promise<FactaConsultaOfflineResultado> {
  const baseUrl = (config.baseUrl || FACTA_DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? 10_000;
  // O manual mostra o exemplo de request com CPF só dígitos ("cpf=00000000000"),
  // mas a mensagem de erro de formato cita "999.999.999-99" (com pontuação) —
  // o próprio documento é inconsistente nisso. Manda só dígitos (bate com o
  // EXEMPLO de request do manual); se a Facta reclamar de formato na prática,
  // é só trocar esse ponto — está isolado aqui, não espalhado pelo worker.
  const cpfLimpo = cpf.replace(/\D/g, "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/clt/base-offline?cpf=${cpfLimpo}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as {
      erro?: boolean;
      mensagem?: string;
      dados?: Record<string, unknown>[];
    } | null;

    if (!response.ok || !body) {
      throw new FactaMargemError(`Facta respondeu ${response.status} na consulta offline`, response.status, body);
    }

    if (body.erro) {
      const mensagem = String(body.mensagem ?? "");
      if (mensagem.includes("Nenhum dado encontrado")) {
        return { dados: null, respostaBruta: body };
      }
      const rateLimited = mensagem.toLowerCase().includes("volte em");
      throw new FactaMargemError(mensagem || "Erro na consulta offline da Facta", response.status, body, rateLimited);
    }

    const primeiro = Array.isArray(body.dados) && body.dados.length > 0 ? body.dados[0] : null;
    return { dados: primeiro, respostaBruta: body };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Consulta ONLINE (04/09, 2ª etapa) — Manual-do-WebService-FACTA-v2.0-
// CONSULTA-DADOS-TRABALHADOR.pdf. Mesma credencial (usuario/senha) da
// consulta offline, mas URL BASE diferente (webservice.facta.com.br, não
// cltoff.facta.com.br) — por isso token PRÓPRIO, não reaproveita o cache
// do token da offline.
//
// IMPORTANTE — os 2 endpoints abaixo (cadastrar-autorizacao-consulta e
// consulta-dados-trabalhador) NÃO estão no manual oficial (que documenta
// só "solicita-autorizacao-consulta", que manda link por SMS/WhatsApp pra
// o cliente clicar, e "autoriza-consulta" pra checar). O que está aqui
// segue EXATAMENTE o exemplo de cURL fornecido no chat (pedido explícito:
// registrar autorização sem precisar de link) — sem documentação formal
// pra confirmar os retornos possíveis, então a leitura da resposta é
// propositalmente defensiva (guarda o corpo bruto inteiro pra conferir
// depois, não assume um formato rígido demais).
const FACTA_ONLINE_DEFAULT_BASE_URL = "https://webservice.facta.com.br";

export interface FactaAutorizacaoOnlineParams {
  averbador: string;
  nome: string;
  cpf: string;
  /** Formato "(00) 00000-0000" — mesmo do exemplo de cURL fornecido. */
  celular: string;
  localizacaoIp: string;
  localizacaoAutorizacao: string;
  /** Se não vier, usa a hora atual no formato "YYYY-MM-DD HH:MM:SS". */
  dataAutorizacaoCliente?: Date;
}

export interface FactaAutorizacaoOnlineResultado {
  /** true quando a mensagem indica que já tinha autorização válida — pode consultar os dados direto, sem esperar. */
  jaAutorizado: boolean;
  respostaBruta: unknown;
}

function formatarDataFacta(data: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())} ${pad(data.getHours())}:${pad(data.getMinutes())}:${pad(data.getSeconds())}`;
}

export async function cadastrarAutorizacaoOnlineFacta(
  config: FactaMargemConfig,
  token: string,
  params: FactaAutorizacaoOnlineParams
): Promise<FactaAutorizacaoOnlineResultado> {
  const baseUrl = (config.baseUrl || FACTA_ONLINE_DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? 15_000;

  // Multipart/form-data (--form no cURL fornecido), não x-www-form-urlencoded
  // (diferente do endpoint documentado oficialmente "solicita-autorizacao-consulta").
  const form = new FormData();
  form.append("averbador", params.averbador);
  form.append("nome", params.nome);
  form.append("cpf", params.cpf.replace(/\D/g, ""));
  form.append("celular", params.celular);
  form.append("tipo_envio", "WHATSAPP");
  form.append("data_autorizacao_cliente", formatarDataFacta(params.dataAutorizacaoCliente ?? new Date()));
  form.append("localizacao_ip", params.localizacaoIp);
  form.append("localizacao_autorizacao", params.localizacaoAutorizacao);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/cadastrar-autorizacao-consulta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as { erro?: boolean; mensagem?: string } | null;
    if (!response.ok || !body) {
      throw new FactaMargemError(`Facta respondeu ${response.status} ao registrar autorização online`, response.status, body);
    }
    if (body.erro) {
      throw new FactaMargemError(body.mensagem || "Erro ao registrar autorização online na Facta", response.status, body);
    }
    const mensagem = String(body.mensagem ?? "").toLowerCase();
    const jaAutorizado = mensagem.includes("não necessita de autorização") || mensagem.includes("nao necessita de autorizacao");
    return { jaAutorizado, respostaBruta: body };
  } finally {
    clearTimeout(timeout);
  }
}

export interface FactaConsultaOnlineResultado {
  /** null quando ainda não processou (precisa esperar mais e tentar de novo) — ver "aindaProcessando". */
  dados: Record<string, unknown> | null;
  /** true quando a resposta indica "ainda não autorizado/processado" — não é erro terminal, só cedo demais. */
  aindaProcessando: boolean;
  respostaBruta: unknown;
}

export async function consultarDadosTrabalhadorOnlineFacta(
  config: FactaMargemConfig,
  token: string,
  cpf: string
): Promise<FactaConsultaOnlineResultado> {
  const baseUrl = (config.baseUrl || FACTA_ONLINE_DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? 15_000;
  const cpfLimpo = cpf.replace(/\D/g, "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Nome do endpoint conforme fornecido no chat (não é o mesmo nome do
    // manual oficial, que documenta "autoriza-consulta" — ver comentário
    // no topo desta seção).
    const response = await fetch(`${baseUrl}/consignado-trabalhador/consulta-dados-trabalhador?cpf=${cpfLimpo}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as {
      erro?: boolean;
      mensagem?: string;
      dados_trabalhador?: { total?: number; dados?: Record<string, unknown>[] };
    } | null;

    if (!response.ok || !body) {
      throw new FactaMargemError(`Facta respondeu ${response.status} na consulta online`, response.status, body);
    }

    if (body.erro) {
      const mensagem = String(body.mensagem ?? "").toLowerCase();
      // Baseado nas mensagens do endpoint IRMÃO documentado oficialmente
      // (autoriza-consulta) — "token expirado" ali significa "ainda não
      // autorizou", não é erro nosso.
      const aindaProcessando = mensagem.includes("token expirado") || mensagem.includes("não autorizado") || mensagem.includes("nao autorizado");
      if (aindaProcessando) {
        return { dados: null, aindaProcessando: true, respostaBruta: body };
      }
      throw new FactaMargemError(body.mensagem || "Erro na consulta online da Facta", response.status, body);
    }

    const lista = body.dados_trabalhador?.dados;
    const primeiro = Array.isArray(lista) && lista.length > 0 ? lista[0] : null;
    return { dados: primeiro, aindaProcessando: false, respostaBruta: body };
  } finally {
    clearTimeout(timeout);
  }
}

