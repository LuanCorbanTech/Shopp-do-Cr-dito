import { describe, expect, it } from "vitest";
import { runLimitWorkerOnce } from "./worker1-limit";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

describe("runLimitWorkerOnce", () => {
  it("usa o telefone original e ignora a Lemit quando desativada (item 8)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", false);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372" });

    let called = false;
    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async () => {
          called = true;
          return { telefoneAtualizado: "5562999999999", possuiWhatsappSegundoLemit: null, dadosPessoa: null, respostaBruta: null };
        },
      },
    });

    expect(called).toBe(false);
    expect(repo.offers.get(offer.id)?.status).toBe("TELEFONE_ATUALIZADO");
    expect(repo.offers.get(offer.id)?.telefoneAtualizado).toBeNull();
  });

  it("ignora a Lemit quando o lead não tem CPF, mesmo com a consulta ativada", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: null });

    let called = false;
    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async () => {
          called = true;
          return { telefoneAtualizado: "5562999999999", possuiWhatsappSegundoLemit: null, dadosPessoa: null, respostaBruta: null };
        },
      },
    });

    expect(called).toBe(false);
    expect(repo.offers.get(offer.id)?.status).toBe("TELEFONE_ATUALIZADO");
    expect(repo.offers.get(offer.id)?.telefoneAtualizado).toBeNull();
  });

  it("chama a Lemit por CPF e grava o telefone escolhido + os dados da pessoa quando ativada", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372", nome: "Pablo (nome do parceiro)" });

    let documentoRecebido: string | null = null;
    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async ({ documento }) => {
          documentoRecebido = documento;
          return {
            telefoneAtualizado: "5585992100340",
            possuiWhatsappSegundoLemit: true,
            dadosPessoa: { nome: "PABLO HEIDY BEZERRA DA SILVA", cpf: "85868388372" },
            respostaBruta: { pessoa: { nome: "PABLO HEIDY BEZERRA DA SILVA" } },
          };
        },
      },
    });

    expect(documentoRecebido).toBe("85868388372");
    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("TELEFONE_ATUALIZADO");
    expect(updated?.telefoneAtualizado).toBe("5585992100340");
    expect(updated?.dadosPessoaLemit).toEqual({ nome: "PABLO HEIDY BEZERRA DA SILVA", cpf: "85868388372" });
    expect(updated?.possuiWhatsappSegundoLemit).toBe(true);
    // Pedido explícito: o nome da Lemit atualiza o nome da oferta (mais
    // confiável/completo que o que o parceiro mandou na captação).
    expect(updated?.nome).toBe("PABLO HEIDY BEZERRA DA SILVA");
  });

  it("mantém o nome já existente quando a Lemit não devolve nenhum nome", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372", nome: "Nome Original Do Parceiro" });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async () => ({
          telefoneAtualizado: "5585992100340",
          possuiWhatsappSegundoLemit: true,
          dadosPessoa: { cpf: "85868388372" }, // sem campo "nome" na resposta
          respostaBruta: {},
        }),
      },
    });

    const updated = repo.offers.get(offer.id);
    expect(updated?.nome).toBe("Nome Original Do Parceiro");
  });

  it("mantém o telefone original quando a Lemit não devolve nenhum celular usável", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true);
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372" });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async () => ({
          telefoneAtualizado: null,
          possuiWhatsappSegundoLemit: null,
          dadosPessoa: { nome: "SEM CELULAR" },
          respostaBruta: {},
        }),
      },
    });

    expect(repo.offers.get(offer.id)?.telefoneAtualizado).toBe("62999999999");
  });

  it("agenda retry (não cancela) quando ainda há tentativas disponíveis", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true, { maxTentativas: 3 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372" });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => { throw new Error("timeout"); } },
      now: new Date("2026-08-14T12:00:00Z"),
    });

    const failed = repo.offers.get(offer.id);
    expect(failed?.status).toBe("ERRO_TELEFONE");
    expect(failed?.tentativasTelefone).toBe(1);
    expect(failed?.proximaTentativaEm).not.toBeNull();
  });

  it("cancela ao esgotar o número máximo de tentativas — nunca é retry infinito", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true, { maxTentativas: 1 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372" });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => { throw new Error("timeout"); } },
    });

    const failed = repo.offers.get(offer.id);
    expect(failed?.status).toBe("CANCELADO");
    expect(failed?.proximaTentativaEm).toBeNull();
  });
});
