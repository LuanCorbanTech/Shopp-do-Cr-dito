import { describe, expect, it } from "vitest";
import { escolherMelhorTelefoneLemit } from "./lemit-phone-selection";

describe("escolherMelhorTelefoneLemit", () => {
  it("escolhe o de melhor ranking entre os que têm whatsapp=true", () => {
    const escolhido = escolherMelhorTelefoneLemit([
      { ddd: 85, numero: "996888516", ranking: 2, whatsapp: true },
      { ddd: 85, numero: "992100340", ranking: 1, whatsapp: true },
      { ddd: 85, numero: "988092344", ranking: 3, whatsapp: false },
    ]);

    expect(escolhido).toEqual({ telefone: "5585992100340", possuiWhatsappSegundoLemit: true });
  });

  it("ignora o de melhor ranking se ele não tem whatsapp, preferindo o próximo que tenha", () => {
    const escolhido = escolherMelhorTelefoneLemit([
      { ddd: 85, numero: "111111111", ranking: 1, whatsapp: false },
      { ddd: 85, numero: "222222222", ranking: 2, whatsapp: true },
    ]);

    expect(escolhido).toEqual({ telefone: "5585222222222", possuiWhatsappSegundoLemit: true });
  });

  it("cai pro de melhor ranking quando nenhum tem whatsapp=true", () => {
    const escolhido = escolherMelhorTelefoneLemit([
      { ddd: 85, numero: "222222222", ranking: 2, whatsapp: false },
      { ddd: 85, numero: "111111111", ranking: 1, whatsapp: false },
    ]);

    expect(escolhido).toEqual({ telefone: "5585111111111", possuiWhatsappSegundoLemit: false });
  });

  it("devolve null quando a lista está vazia, ausente ou não é um array", () => {
    expect(escolherMelhorTelefoneLemit([])).toBeNull();
    expect(escolherMelhorTelefoneLemit(undefined)).toBeNull();
    expect(escolherMelhorTelefoneLemit(null)).toBeNull();
    expect(escolherMelhorTelefoneLemit("não é uma lista")).toBeNull();
  });

  it("ignora entradas malformadas e usa as válidas restantes", () => {
    const escolhido = escolherMelhorTelefoneLemit([
      { ddd: 85, numero: "111111111" }, // sem ranking/whatsapp — malformado
      { ddd: 85, numero: "222222222", ranking: 1, whatsapp: true },
    ]);

    expect(escolhido).toEqual({ telefone: "5585222222222", possuiWhatsappSegundoLemit: true });
  });

  it("devolve null quando todas as entradas são malformadas", () => {
    expect(escolherMelhorTelefoneLemit([{ foo: "bar" }, 42, null])).toBeNull();
  });
});
