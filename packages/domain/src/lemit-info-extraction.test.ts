import { describe, expect, it } from "vitest";
import { extrairDataNascimentoLemit, extrairInfoPessoaLemit } from "./lemit-info-extraction";

describe("extrairDataNascimentoLemit", () => {
  it("extrai corretamente o formato real devolvido pela Lemit (ISO com timezone)", () => {
    const dadosPessoa = { data_nascimento: "1990-02-03T00:00:00-02:00" };
    const resultado = extrairDataNascimentoLemit(dadosPessoa);
    expect(resultado).toBeInstanceOf(Date);
    expect(resultado?.toISOString()).toBe("1990-02-03T02:00:00.000Z");
  });

  it("devolve null quando dadosPessoa é null", () => {
    expect(extrairDataNascimentoLemit(null)).toBeNull();
  });

  it("devolve null quando o campo não existe", () => {
    expect(extrairDataNascimentoLemit({ nome: "Fulano" })).toBeNull();
  });

  it("devolve null quando o campo é uma string vazia", () => {
    expect(extrairDataNascimentoLemit({ data_nascimento: "" })).toBeNull();
  });

  it("devolve null quando o campo não é uma data válida", () => {
    expect(extrairDataNascimentoLemit({ data_nascimento: "não é uma data" })).toBeNull();
  });

  it("devolve null quando o campo não é string (ex.: veio como número por engano)", () => {
    expect(extrairDataNascimentoLemit({ data_nascimento: 12345 })).toBeNull();
  });
});

// Exemplo real de resposta da Lemit (visto em produção, 17/08) — usado aqui
// como fixture pros testes de extrairInfoPessoaLemit.
const RESPOSTA_REAL_LEMIT: Record<string, unknown> = {
  cpf: "03073732152",
  nome: "LUCAS MENDES BORGES",
  sexo: "M",
  emails: [
    { email: "lmbdigital10@gmail.com", ranking: 1, possui_cookie: false },
    { email: "mborgeslucas@hotmail.com", ranking: 2, possui_cookie: false },
  ],
  nome_mae: "ORDALICE PIRES MENDES",
  celulares: [
    { ddd: 62, plus: true, numero: "993718537", ranking: 1, whatsapp: true },
    { ddd: 62, plus: true, numero: "992910162", ranking: 2, whatsapp: false },
  ],
  enderecos: [
    {
      uf: "GO", cep: "74215095", tipo: "residencial", bairro: "ST BUENO", cidade: "GOIANIA",
      numero: "20", ranking: 1, endereco: "AV T 3 20 A22 N1 ATE1245 LA", logradouro: "AV  T 3",
      complemento: "A22 N1 ATE1245 LA",
    },
    {
      uf: "GO", cep: "74423270", tipo: "comercial", bairro: "CJ GUADALAJARA", cidade: "GOIANIA",
      numero: "1", ranking: 2, endereco: "R NATAL E SILVA 1", logradouro: "R  NATAL E SILVA", complemento: null,
    },
  ],
  data_nascimento: "1990-02-03T00:00:00-02:00",
};

describe("extrairInfoPessoaLemit", () => {
  it("extrai todos os campos corretamente do exemplo real de resposta da Lemit", () => {
    const info = extrairInfoPessoaLemit(RESPOSTA_REAL_LEMIT);
    expect(info).toEqual({
      sexo: "M",
      nomeMae: "ORDALICE PIRES MENDES",
      dataNascimento: new Date("1990-02-03T02:00:00.000Z"),
      email: "lmbdigital10@gmail.com", // ranking 1
      telefone: "62993718537", // ddd + numero do celular de ranking 1
      whatsapp: true, // celular de ranking 1
      endereco: "AV T 3 20 A22 N1 ATE1245 LA", // ranking 1
      uf: "GO",
      cep: "74215095",
      bairro: "ST BUENO",
      cidade: "GOIANIA",
      numero: "20",
      logradouro: "AV  T 3",
      complemento: "A22 N1 ATE1245 LA",
    });
  });

  it("devolve tudo null quando dadosPessoa é null", () => {
    const info = extrairInfoPessoaLemit(null);
    expect(info.sexo).toBeNull();
    expect(info.email).toBeNull();
    expect(info.telefone).toBeNull();
    expect(info.whatsapp).toBeNull();
    expect(info.endereco).toBeNull();
    expect(info.dataNascimento).toBeNull();
  });

  it("devolve null campo a campo quando faltar informação (sem lançar erro)", () => {
    const info = extrairInfoPessoaLemit({ nome: "Fulano" });
    expect(info.sexo).toBeNull();
    expect(info.nomeMae).toBeNull();
    expect(info.email).toBeNull();
    expect(info.telefone).toBeNull();
    expect(info.endereco).toBeNull();
  });

  it("pega a entrada de MELHOR ranking (número mais baixo), não a primeira da lista", () => {
    const dadosPessoa = {
      emails: [
        { email: "pior@example.com", ranking: 5 },
        { email: "melhor@example.com", ranking: 1 },
      ],
    };
    const info = extrairInfoPessoaLemit(dadosPessoa);
    expect(info.email).toBe("melhor@example.com");
  });

  it("não lança erro com listas vazias ou em formato inesperado", () => {
    expect(() => extrairInfoPessoaLemit({ emails: [], celulares: "não é lista", enderecos: null })).not.toThrow();
    const info = extrairInfoPessoaLemit({ emails: [], celulares: "não é lista", enderecos: null });
    expect(info.email).toBeNull();
    expect(info.telefone).toBeNull();
    expect(info.endereco).toBeNull();
  });

  it("complemento null na origem (não string vazia) continua null no resultado", () => {
    const dadosPessoa = {
      enderecos: [{ ranking: 1, endereco: "R X 1", uf: "GO", complemento: null }],
    };
    const info = extrairInfoPessoaLemit(dadosPessoa);
    expect(info.complemento).toBeNull();
    expect(info.endereco).toBe("R X 1");
  });
});
