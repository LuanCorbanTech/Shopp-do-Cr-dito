import { describe, expect, it } from "vitest";
import { runMargemFactaOnlineWorkerOnce, formatarCelularFacta, type FactaOnlineService } from "./worker0b-margem-facta-online";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

function servicoFake(overrides: Partial<FactaOnlineService> = {}): FactaOnlineService {
  return {
    gerarToken: async () => ({ token: "token-fake", expiraEm: new Date(Date.now() + 3600_000) }),
    cadastrarAutorizacao: async () => ({ jaAutorizado: false, respostaBruta: { erro: false, mensagem: "Solicitação enviada com sucesso!" } }),
    consultarDados: async () => ({ dados: { valorMargemDisponivel: "500.00" }, aindaProcessando: false, respostaBruta: {} }),
    ...overrides,
  };
}

describe("formatarCelularFacta", () => {
  it("formata telefone de 11 dígitos sem DDI", () => {
    expect(formatarCelularFacta("67996683738")).toBe("(67) 99668-3738");
  });
  it("formata telefone com DDI (55), removendo antes de formatar", () => {
    expect(formatarCelularFacta("5567996683738")).toBe("(67) 99668-3738");
  });
  it("formata telefone de 10 dígitos (fixo, sem o 9)", () => {
    expect(formatarCelularFacta("6733334444")).toBe("(67) 3333-4444");
  });
});

describe("runMargemFactaOnlineWorkerOnce — Fase 1 (registrar autorização)", () => {
  it("não faz nada quando a integração está desativada", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", false, { usuario: "u", senha: "s" });
    repo.addOffer({ telefoneOriginal: "67996683738", cpf: "11111111111", status: "AGUARDANDO_CONSULTA_ONLINE" });

    const resultado = await runMargemFactaOnlineWorkerOnce({ port: repo, configPort: repo, factaService: servicoFake() });
    expect(resultado.autorizacoesRegistradas).toBe(0);
  });

  it("registra a autorização e agenda a checagem pra depois da janela de espera", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: "67996683738", cpf: "11111111111", nome: "Fulano", status: "AGUARDANDO_CONSULTA_ONLINE" });

    let paramsRecebidos: unknown = null;
    const antes = new Date();
    await runMargemFactaOnlineWorkerOnce({
      port: repo,
      configPort: repo,
      esperaAposRegistrarMs: 60_000,
      now: antes,
      factaService: servicoFake({
        cadastrarAutorizacao: async (_c, _t, params) => { paramsRecebidos = params; return { jaAutorizado: false, respostaBruta: { ok: true } }; },
      }),
    });

    const atualizada = repo.offers.get(offer.id)!;
    expect(atualizada.status).toBe("AGUARDANDO_RESULTADO_ONLINE_FACTA");
    expect(atualizada.proximaTentativaOnlineFactaEm?.getTime()).toBe(antes.getTime() + 60_000);
    expect(paramsRecebidos).toMatchObject({ averbador: "10010", cpf: "11111111111", nome: "Fulano", celular: "(67) 99668-3738" });
  });

  it('usa uma espera BEM mais curta quando a Facta já responde "não necessita de autorização"', async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: "67996683738", cpf: "11111111111", status: "AGUARDANDO_CONSULTA_ONLINE" });

    const antes = new Date();
    await runMargemFactaOnlineWorkerOnce({
      port: repo,
      configPort: repo,
      esperaAposRegistrarMs: 60_000,
      now: antes,
      factaService: servicoFake({
        cadastrarAutorizacao: async () => ({ jaAutorizado: true, respostaBruta: { mensagem: "Token válido. Não necessita de autorização." } }),
      }),
    });

    const atualizada = repo.offers.get(offer.id)!;
    expect(atualizada.proximaTentativaOnlineFactaEm!.getTime()).toBeLessThan(antes.getTime() + 60_000);
  });

  it("falha aberta (MARGEM_APROVADA) direto quando não tem CPF ou telefone — não tem como registrar autorização", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: null, cpf: "11111111111", status: "AGUARDANDO_CONSULTA_ONLINE" });

    const resultado = await runMargemFactaOnlineWorkerOnce({ port: repo, configPort: repo, factaService: servicoFake() });

    expect(resultado.falhasAbertas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_APROVADA");
  });

  it("erro transitório ao registrar: volta pra AGUARDANDO_CONSULTA_ONLINE, agenda nova tentativa (não avança de fase)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({ telefoneOriginal: "67996683738", cpf: "11111111111", status: "AGUARDANDO_CONSULTA_ONLINE" });

    const resultado = await runMargemFactaOnlineWorkerOnce({
      port: repo,
      configPort: repo,
      factaService: servicoFake({ cadastrarAutorizacao: async () => { throw new Error("Facta fora do ar"); } }),
    });

    expect(resultado.erroRegistrar).toBe(1);
    const atualizada = repo.offers.get(offer.id)!;
    expect(atualizada.status).toBe("AGUARDANDO_CONSULTA_ONLINE");
    expect(atualizada.tentativasOnlineFacta).toBe(1);
  });
});

describe("runMargemFactaOnlineWorkerOnce — Fase 2 (checar resultado)", () => {
  it("MARGEM_APROVADA quando valorMargemDisponivel > 0", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({
      telefoneOriginal: "67996683738", cpf: "11111111111",
      status: "AGUARDANDO_RESULTADO_ONLINE_FACTA", proximaTentativaOnlineFactaEm: new Date(Date.now() - 1000),
    });

    const resultado = await runMargemFactaOnlineWorkerOnce({
      port: repo, configPort: repo,
      factaService: servicoFake({ consultarDados: async () => ({ dados: { valorMargemDisponivel: "300.00" }, aindaProcessando: false, respostaBruta: {} }) }),
    });

    expect(resultado.aprovadas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_APROVADA");
    expect(repo.offers.get(offer.id)?.valorMargemDisponivelFacta).toBe(300);
  });

  it("MARGEM_NEGATIVA quando valorMargemDisponivel <= 0", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({
      telefoneOriginal: "67996683738", cpf: "11111111111",
      status: "AGUARDANDO_RESULTADO_ONLINE_FACTA", proximaTentativaOnlineFactaEm: new Date(Date.now() - 1000),
    });

    const resultado = await runMargemFactaOnlineWorkerOnce({
      port: repo, configPort: repo,
      factaService: servicoFake({ consultarDados: async () => ({ dados: { valorMargemDisponivel: "0.00" }, aindaProcessando: false, respostaBruta: {} }) }),
    });

    expect(resultado.negativas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_NEGATIVA");
  });

  it('"ainda processando" (não é erro): agenda nova checagem, permanece esperando', async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    const offer = repo.addOffer({
      telefoneOriginal: "67996683738", cpf: "11111111111",
      status: "AGUARDANDO_RESULTADO_ONLINE_FACTA", proximaTentativaOnlineFactaEm: new Date(Date.now() - 1000),
    });

    const resultado = await runMargemFactaOnlineWorkerOnce({
      port: repo, configPort: repo,
      factaService: servicoFake({ consultarDados: async () => ({ dados: null, aindaProcessando: true, respostaBruta: { mensagem: "Token expirado" } }) }),
    });

    expect(resultado.aindaProcessando).toBe(1);
    const atualizada = repo.offers.get(offer.id)!;
    expect(atualizada.status).toBe("AGUARDANDO_RESULTADO_ONLINE_FACTA");
    expect(atualizada.tentativasOnlineFacta).toBe(1);
  });

  it("FALHA ABERTA depois de esgotar tentativas checando (nunca processou)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s", maxTentativasOnline: 2 });
    const offer = repo.addOffer({
      telefoneOriginal: "67996683738", cpf: "11111111111", tentativasOnlineFacta: 1,
      status: "AGUARDANDO_RESULTADO_ONLINE_FACTA", proximaTentativaOnlineFactaEm: new Date(Date.now() - 1000),
    });

    const resultado = await runMargemFactaOnlineWorkerOnce({
      port: repo, configPort: repo,
      factaService: servicoFake({ consultarDados: async () => ({ dados: null, aindaProcessando: true, respostaBruta: {} }) }),
    });

    expect(resultado.falhasAbertas).toBe(1);
    expect(repo.offers.get(offer.id)?.status).toBe("MARGEM_APROVADA");
  });

  it("NÃO pega quem ainda está dentro da janela de espera", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    repo.addOffer({
      telefoneOriginal: "67996683738", cpf: "11111111111",
      status: "AGUARDANDO_RESULTADO_ONLINE_FACTA", proximaTentativaOnlineFactaEm: new Date(Date.now() + 3600_000),
    });

    let chamouConsulta = false;
    const resultado = await runMargemFactaOnlineWorkerOnce({
      port: repo, configPort: repo,
      factaService: servicoFake({ consultarDados: async () => { chamouConsulta = true; return { dados: null, aindaProcessando: false, respostaBruta: {} }; } }),
    });

    expect(chamouConsulta).toBe(false);
    expect(resultado.aprovadas + resultado.negativas + resultado.aindaProcessando).toBe(0);
  });
});

describe("runMargemFactaOnlineWorkerOnce — as 2 fases no mesmo ciclo", () => {
  it("processa fase 1 e fase 2 juntas quando ambas têm ofertas prontas", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.setConfig("FACTA_MARGEM_CREDENCIAIS", true, { usuario: "u", senha: "s" });
    repo.addOffer({ telefoneOriginal: "67996683738", cpf: "11111111111", status: "AGUARDANDO_CONSULTA_ONLINE" });
    repo.addOffer({
      telefoneOriginal: "61999999999", cpf: "22222222222",
      status: "AGUARDANDO_RESULTADO_ONLINE_FACTA", proximaTentativaOnlineFactaEm: new Date(Date.now() - 1000),
    });

    const resultado = await runMargemFactaOnlineWorkerOnce({ port: repo, configPort: repo, factaService: servicoFake() });

    expect(resultado.autorizacoesRegistradas).toBe(1);
    expect(resultado.aprovadas).toBe(1);
  });
});
