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
