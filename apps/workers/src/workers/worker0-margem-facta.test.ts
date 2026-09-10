import { describe, expect, it } from "vitest";
import { runMargemFactaWorkerOnce, type FactaMargemService } from "./worker0-margem-facta";
import { FactaMargemError } from "../fornecedores/facta-margem";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

function servicoFake(overrides: Partial<FactaMargemService> = {}): FactaMargemService {
  return {
    gerarToken: async () => ({ token: "token-fake", expiraEm: new Date(Date.now() + 3600_000) }),
    consultarCpf: async () => ({ dados: { valorMargemDisponivel: "500.00" }, respostaBruta: {} }),
    ...overrides,
  };
}

describe("runMargemFactaWorkerOnce", () => {
  it("não faz nada quando não tem nenhuma oferta RECEBIDO", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const resultado = await runMargemFactaWorkerOnce({ port: repo, configPort: repo, factaService: servicoFake() });
    expect(resultado).toEqual({ aprovadas: 0, negativas: 0, aguardandoOnline: 0, erros: 0 });
  });

  it("MARGEM_APROVADA quando valorMargemDisponivel > 0", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "12345678900" });

    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({ consultarCpf: async () => ({ dados: { valorMargemDisponivel: "185.12" }, respostaBruta: { ok: true } }) }),
    });

    expect(resultado.aprovadas).toBe(1);
    const atualizada = repo.offers.get(offer.id)!;
    expect(atualizada.status).toBe("MARGEM_APROVADA");
    expect(atualizada.valorMargemDisponivelFacta).toBe(185.12);
    expect(atualizada.dadosFactaOffline).toEqual({ valorMargemDisponivel: "185.12" });
  });

  it("MARGEM_NEGATIVA quando valorMargemDisponivel é 0", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({
      telefoneOriginal: null,
      cpf: "12345678900",
    });

    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({ consultarCpf: async () => ({ dados: { valorMargemDisponivel: "0.00" }, respostaBruta: {} }) }),
    });

    expect(resultado.negativas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_NEGATIVA");
  });

  it("MARGEM_NEGATIVA quando valorMargemDisponivel é negativo", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "12345678900" });

    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({ consultarCpf: async () => ({ dados: { valorMargemDisponivel: "-50.00" }, respostaBruta: {} }) }),
    });

    expect(resultado.negativas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_NEGATIVA");
    expect(repo.offers.get(offer.id)?.valorMargemDisponivelFacta).toBe(-50);
  });

  it("AGUARDANDO_CONSULTA_ONLINE quando a Facta responde 'Nenhum dado encontrado' (dados null)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "12345678900" });

    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({ consultarCpf: async () => ({ dados: null, respostaBruta: { erro: true, mensagem: "Nenhum dado encontrado!" } }) }),
    });

    expect(resultado.aguardandoOnline).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("AGUARDANDO_CONSULTA_ONLINE");
  });

  it("integração DESATIVADA no painel: aprova todo mundo direto, sem chamar a Facta", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", false, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "12345678900" });

    let chamouFacta = false;
    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({ consultarCpf: async () => { chamouFacta = true; return { dados: null, respostaBruta: {} }; } }),
    });

    expect(chamouFacta).toBe(false);
    expect(resultado.aprovadas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_APROVADA");
    expect(repo.offers.get(offer.id)?.valorMargemDisponivelFacta).toBeNull();
  });

  it("lead SEM CPF: aprova direto, sem chamar a Facta (não tem como consultar)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: null });

    let chamouFacta = false;
    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({ consultarCpf: async () => { chamouFacta = true; return { dados: null, respostaBruta: {} }; } }),
    });

    expect(chamouFacta).toBe(false);
    expect(resultado.aprovadas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_APROVADA");
  });

  it("ativado mas SEM usuário/senha configurados: aprova direto (não trava o funil por credencial faltando), loga erro", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, {}); // sem usuario/senha
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "12345678900" });

    const resultado = await runMargemFactaWorkerOnce({ port: repo, configPort: repo, factaService: servicoFake() });

    expect(resultado.aprovadas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_APROVADA");
  });

  it("erro transitório (ex.: rate limit): agenda nova tentativa, NÃO termina a oferta", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "12345678900" });

    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({
        consultarCpf: async () => { throw new FactaMargemError("Consulta de base offline indisponível, volte em 3 segundos", 200, null, true); },
      }),
    });

    expect(resultado.erros).toBe(1);
    const atualizada = repo.offers.get(offer.id)!;
    expect(atualizada.status).toBe("RECEBIDO"); // volta pra RECEBIDO, tenta de novo depois
    expect(atualizada.tentativasMargemFacta).toBe(1);
    expect(atualizada.proximaTentativaMargemEm).not.toBeNull();
  });

  it("FALHA ABERTA: depois de esgotar as tentativas, libera a oferta (MARGEM_APROVADA) em vez de travar pra sempre", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s", maxTentativas: 2 });
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "12345678900", tentativasMargemFacta: 1 }); // já tentou 1x antes

    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({ consultarCpf: async () => { throw new Error("Facta fora do ar"); } }),
    });

    expect(resultado.aprovadas).toBe(1);
    expect(resultado.erros).toBe(0);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_APROVADA");
  });

  it("reaproveita o token em cache (não gera um novo se ainda válido)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    repo.addOffer({ telefoneOriginal: null, cpf: "11111111111" });
    repo.addOffer({ telefoneOriginal: null, cpf: "22222222222" });

    let chamadasToken = 0;
    await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      batchSize: 2,
      factaService: servicoFake({
        gerarToken: async () => { chamadasToken += 1; return { token: "token-x", expiraEm: new Date(Date.now() + 3600_000) }; },
      }),
    });

    expect(chamadasToken).toBe(1); // só gerou 1 vez, reaproveitou pro segundo CPF
  });

  it("gera um token NOVO quando o do cache já expirou", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    await repo.salvarTokenFactaCache("token-velho", new Date(Date.now() - 1000)); // já expirado
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "12345678900" });

    let tokenUsado: string | null = null;
    await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({
        gerarToken: async () => ({ token: "token-novo", expiraEm: new Date(Date.now() + 3600_000) }),
        consultarCpf: async (_config, token) => { tokenUsado = token; return { dados: { valorMargemDisponivel: "100" }, respostaBruta: {} }; },
      }),
    });

    expect(tokenUsado).toBe("token-novo");
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_APROVADA");
  });

  it("processa várias ofertas no mesmo ciclo quando batchSize > 1", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    repo.addOffer({ telefoneOriginal: null, cpf: "11111111111" });
    repo.addOffer({ telefoneOriginal: null, cpf: "22222222222" });
    repo.addOffer({ telefoneOriginal: null, cpf: "33333333333" });

    const resultado = await runMargemFactaWorkerOnce({
      port: repo,
      configPort: repo,
      batchSize: 3,
      factaService: servicoFake(),
    });

    expect(resultado.aprovadas).toBe(3);
  });
});
