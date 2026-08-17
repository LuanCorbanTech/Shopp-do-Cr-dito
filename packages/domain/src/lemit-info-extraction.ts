// A Lemit devolve (dentro do objeto "pessoa") um conjunto rico de dados
// cadastrais — alguns campos simples (sexo, nome_mae, data_nascimento) e
// outros como LISTAS com "ranking" (1 = melhor, segundo o critério deles):
// emails, celulares, enderecos. Essa é a extração pura — sem HTTP — de tudo
// que deve ser promovido pra colunas próprias da oferta (pedido explícito do
// cliente: nome, cpf, sexo, nome_mae, data_nascimento, email, telefone,
// whatsapp, endereço completo). Sempre pega a entrada de melhor ranking de
// cada lista; se um campo não existir ou vier num formato inesperado, o
// resultado pra aquele campo específico é null — nunca lança erro (um
// problema de formatação num campo não deve travar o enriquecimento do lead
// como um todo).
//
// Importante: esses campos são só um "retrato" da resposta da Lemit, pra
// exibição/registro (ex.: modal "ver tudo" no painel admin) — são
// independentes dos campos que o pipeline usa pra decidir o fluxo
// (telefoneAtualizado/telefoneValidado/possuiWhatsapp, que continuam vindo de
// escolherMelhorTelefoneLemit e da validação oficial do Worker 2).
//
// Exceção: "nome" é usado pra ATUALIZAR o nome da oferta (pedido explícito —
// a Lemit costuma devolver o nome completo/correto, mais confiável que o que
// o parceiro mandou na captação). A atualização só acontece quando a Lemit
// devolve um nome de verdade — se vier null aqui, quem grava (markPhoneUpdated)
// mantém o nome que já existia, nunca apaga um nome já preenchido.

export interface InfoPessoaLemit {
  nome: string | null;
  sexo: string | null;
  nomeMae: string | null;
  dataNascimento: Date | null;
  email: string | null;
  telefone: string | null;
  whatsapp: boolean | null;
  endereco: string | null;
  uf: string | null;
  cep: string | null;
  bairro: string | null;
  cidade: string | null;
  numero: string | null;
  logradouro: string | null;
  complemento: string | null;
}

function melhorEntrada<T extends { ranking?: unknown }>(lista: unknown): T | null {
  if (!Array.isArray(lista) || lista.length === 0) return null;
  const validos = lista.filter((item): item is T => typeof item === "object" && item !== null);
  if (validos.length === 0) return null;
  return validos.reduce((melhor, atual) => {
    const rankMelhor = typeof melhor.ranking === "number" ? melhor.ranking : Infinity;
    const rankAtual = typeof atual.ranking === "number" ? atual.ranking : Infinity;
    return rankAtual < rankMelhor ? atual : melhor;
  });
}

function stringOuNull(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : null;
}

function boolOuNull(valor: unknown): boolean | null {
  return typeof valor === "boolean" ? valor : null;
}

export function extrairDataNascimentoLemit(dadosPessoa: Record<string, unknown> | null): Date | null {
  if (!dadosPessoa) return null;
  const bruta = dadosPessoa.data_nascimento;
  if (typeof bruta !== "string" || bruta.trim().length === 0) return null;
  const data = new Date(bruta);
  if (Number.isNaN(data.getTime())) return null;
  return data;
}

export function extrairInfoPessoaLemit(dadosPessoa: Record<string, unknown> | null): InfoPessoaLemit {
  const vazio: InfoPessoaLemit = {
    nome: null,
    sexo: null,
    nomeMae: null,
    dataNascimento: null,
    email: null,
    telefone: null,
    whatsapp: null,
    endereco: null,
    uf: null,
    cep: null,
    bairro: null,
    cidade: null,
    numero: null,
    logradouro: null,
    complemento: null,
  };
  if (!dadosPessoa) return vazio;

  const melhorEmail = melhorEntrada<{ email?: unknown; ranking?: unknown }>(dadosPessoa.emails);
  const melhorCelular = melhorEntrada<{ ddd?: unknown; numero?: unknown; whatsapp?: unknown; ranking?: unknown }>(
    dadosPessoa.celulares
  );
  const melhorEndereco = melhorEntrada<{
    endereco?: unknown;
    uf?: unknown;
    cep?: unknown;
    bairro?: unknown;
    cidade?: unknown;
    numero?: unknown;
    logradouro?: unknown;
    complemento?: unknown;
    ranking?: unknown;
  }>(dadosPessoa.enderecos);

  let telefoneCompleto: string | null = null;
  if (melhorCelular) {
    const ddd = stringOuNull(String(melhorCelular.ddd ?? ""));
    const numero = stringOuNull(String(melhorCelular.numero ?? ""));
    telefoneCompleto = ddd && numero ? `${ddd}${numero}` : numero;
  }

  return {
    nome: stringOuNull(dadosPessoa.nome),
    sexo: stringOuNull(dadosPessoa.sexo),
    nomeMae: stringOuNull(dadosPessoa.nome_mae),
    dataNascimento: extrairDataNascimentoLemit(dadosPessoa),
    email: melhorEmail ? stringOuNull(melhorEmail.email) : null,
    telefone: telefoneCompleto,
    whatsapp: melhorCelular ? boolOuNull(melhorCelular.whatsapp) : null,
    endereco: melhorEndereco ? stringOuNull(melhorEndereco.endereco) : null,
    uf: melhorEndereco ? stringOuNull(melhorEndereco.uf) : null,
    cep: melhorEndereco ? stringOuNull(melhorEndereco.cep) : null,
    bairro: melhorEndereco ? stringOuNull(melhorEndereco.bairro) : null,
    cidade: melhorEndereco ? stringOuNull(melhorEndereco.cidade) : null,
    numero: melhorEndereco ? stringOuNull(melhorEndereco.numero) : null,
    logradouro: melhorEndereco ? stringOuNull(melhorEndereco.logradouro) : null,
    complemento: melhorEndereco ? stringOuNull(melhorEndereco.complemento) : null,
  };
}

