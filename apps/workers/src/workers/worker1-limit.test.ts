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

  it("guarda o corpo real da resposta de erro da Lemit (não só a mensagem curta) — pra dar pra investigar depois", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true, { maxTentativas: 3 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372" });

    // Simula exatamente o formato do LimitServiceError (packages/integrations/limit) —
    // sem importar a classe real, só duck-typing as propriedades. Usa 500 (erro
    // transitório de verdade) — 404 tem caminho próprio, testado separadamente abaixo.
    const erroComRespostaBruta = Object.assign(new Error("API Lemit respondeu 500"), {
      httpStatus: 500,
      respostaBruta: { erro: "instabilidade temporária" },
    });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async () => {
          throw erroComRespostaBruta;
        },
      },
    });

    const registro = repo.processingLog.find((p) => p.offerId === offer.id && p.etapa === "LIMIT" && p.resultado === "FALHA");
    expect(registro?.respostaBruta).toEqual({ erro: "instabilidade temporária" });
  });

  it("CPF com dígito verificador válido, mas que a Lemit responde 404 (não encontrado) — marca CPF_INVALIDO, terminal, sem agendar retry", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true, { maxTentativas: 3 });
    // CPF real, com dígitos verificadores corretos (confirmado à parte) — o
    // ponto aqui é que a LEMIT não tem registro dele, não que o CPF em si
    // seja mal formatado.
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "33522334388" });

    const erro404 = Object.assign(new Error("API Lemit respondeu 404"), {
      httpStatus: 404,
      respostaBruta: { erro: "CPF não encontrado" },
    });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => { throw erro404; } },
    });

    const offerAtualizada = repo.offers.get(offer.id);
    expect(offerAtualizada?.status).toBe("CPF_INVALIDO");
    // Terminal — nunca agenda uma próxima tentativa, mesmo com tentativas
    // sobrando no orçamento (maxTentativas: 3).
    expect(offerAtualizada?.proximaTentativaEm).toBeNull();

    const registro = repo.processingLog.find((p) => p.offerId === offer.id && p.etapa === "LIMIT" && p.resultado === "CPF_INVALIDO");
    expect(registro).toBeDefined();
    expect(registro?.respostaBruta).toEqual({ erro: "CPF não encontrado" });
  });

  it("não quebra quando o erro NÃO tem respostaBruta (ex.: timeout de rede, sem corpo de resposta nenhum)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true, { maxTentativas: 3 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372" });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => { throw new Error("timeout de rede"); } },
    });

    const registro = repo.processingLog.find((p) => p.offerId === offer.id && p.etapa === "LIMIT" && p.resultado === "FALHA");
    expect(registro?.respostaBruta).toBeUndefined();
  });
});

describe("runLimitWorkerOnce — segunda chance pra quem ficou SEM_WHATSAPP com o telefone original (02/09)", () => {
  it("consulta a Lemit DE VERDADE pra uma oferta SEM_WHATSAPP, mesmo com a Lemit desativada no painel", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", false); // desativada no geral
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      cpf: "85868388372",
      status: "SEM_WHATSAPP",
      telefoneAtualizado: null,
    });

    let chamouComDocumento: string | null = null;
    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async ({ documento }) => {
          chamouComDocumento = documento;
          return { telefoneAtualizado: "5562988888888", possuiWhatsappSegundoLemit: true, dadosPessoa: null, respostaBruta: null };
        },
      },
    });

    // Mesmo desativada no geral, ESSA oferta específica (segunda chance) foi consultada de verdade.
    expect(chamouComDocumento).toBe("85868388372");
    expect(repo.offers.get(offer.id)?.status).toBe("TELEFONE_ATUALIZADO");
    expect(repo.offers.get(offer.id)?.telefoneAtualizado).toBe("5562988888888");
  });

  it("NÃO pega de novo uma oferta SEM_WHATSAPP que JÁ teve telefoneAtualizado preenchido (Lemit já foi consultada uma vez pra ela)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", false);
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999",
      cpf: "85868388372",
      status: "SEM_WHATSAPP",
      telefoneAtualizado: "5562988888888", // JÁ foi consultada antes
    });

    let chamouLemit = false;
    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => { chamouLemit = true; return { telefoneAtualizado: null, possuiWhatsappSegundoLemit: null, dadosPessoa: null, respostaBruta: null }; } },
    });

    expect(chamouLemit).toBe(false);
    expect(repo.offers.get(offer.id)?.status).toBe("SEM_WHATSAPP"); // continua parada, sem loop
  });

  it("não mexe em ofertas RECEBIDO normais quando processa a fila de segunda chance — as duas filas são independentes", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", false);
    const offerRecebida = repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372" }); // RECEBIDO normal
    const offerSegundaChance = repo.addOffer({
      telefoneOriginal: "62988888888", cpf: "11111111111", status: "SEM_WHATSAPP", telefoneAtualizado: null,
    });

    const chamadas: string[] = [];
    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: {
        lookupPhone: async ({ documento }) => {
          chamadas.push(documento);
          return { telefoneAtualizado: "5562977777777", possuiWhatsappSegundoLemit: true, dadosPessoa: null, respostaBruta: null };
        },
      },
    });

    // A RECEBIDA normal foi só "pulada" (Lemit desativada) -- não gerou consulta.
    expect(repo.offers.get(offerRecebida.id)?.status).toBe("TELEFONE_ATUALIZADO");
    expect(repo.offers.get(offerRecebida.id)?.telefoneAtualizado).toBeNull();
    // A de segunda chance SIM gerou uma consulta de verdade.
    expect(chamadas).toEqual(["11111111111"]);
    expect(repo.offers.get(offerSegundaChance.id)?.telefoneAtualizado).toBe("5562977777777");
  });

  it("se a Lemit falhar na segunda chance, entra no mesmo fluxo de retry/erro normal (não trava, não perde a oferta)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", false);
    const offer = repo.addOffer({
      telefoneOriginal: "62999999999", cpf: "85868388372", status: "SEM_WHATSAPP", telefoneAtualizado: null,
    });

    await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => { throw new Error("Lemit fora do ar"); } },
    });

    const registro = repo.processingLog.find((p) => p.offerId === offer.id && p.etapa === "LIMIT" && p.resultado === "FALHA");
    expect(registro).toBeTruthy();
  });

  it("processa as 2 filas no MESMO ciclo (recebidas + segunda chance), contando as duas no total devolvido", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("LIMIT_CONSULTA", true);
    repo.addOffer({ telefoneOriginal: "62999999999", cpf: "85868388372" });
    repo.addOffer({ telefoneOriginal: "62988888888", cpf: "11111111111", status: "SEM_WHATSAPP", telefoneAtualizado: null });

    const total = await runLimitWorkerOnce({
      phonePort: repo,
      configPort: repo,
      limitService: { lookupPhone: async () => ({ telefoneAtualizado: "5562977777777", possuiWhatsappSegundoLemit: true, dadosPessoa: null, respostaBruta: null }) },
    });

    expect(total).toBe(2);
  });
});
