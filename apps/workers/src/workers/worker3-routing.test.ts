import { describe, expect, it } from "vitest";
import { runRoutingWorkerOnce } from "./worker3-routing";
import { InMemoryPipelineRepository } from "./test-support/in-memory-repository";

describe("runRoutingWorkerOnce", () => {
  it("roteia para o endpoint da regra mais específica", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.addEndpoint({
      id: "endpoint-c6-a",
      nome: "C6 A",
      url: "https://example.com/c6a",
      metodoHttp: "POST",
      headers: null,
      authType: "NONE",
      credenciaisRef: null,
      capacidadeMinuto: null,
      capacidadeHora: 100,
      capacidadeDia: null,
      timeoutMs: 5000,
      maxTentativas: 3,
      ativo: true,
    });
    repo.addRule({ id: "rule-specific", condicoes: { bancoAutorizado: "C6", webhookId: "webhook-1" }, endpointId: "endpoint-c6-a", prioridade: 1 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "AGUARDANDO_ROTEAMENTO", bancoAutorizado: "C6", webhookId: "webhook-1" });

    await runRoutingWorkerOnce({ routingPort: repo });

    const updated = repo.offers.get(offer.id);
    expect(updated?.status).toBe("AGUARDANDO_ENVIO");
    expect(updated?.endpointId).toBe("endpoint-c6-a");
    expect(updated?.routingRuleId).toBe("rule-specific");
  });

  it("marca SEM_ROTA_CONFIGURADA quando nenhuma regra casa (oferta não é descartada)", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.addRule({ id: "rule-itau", condicoes: { bancoAutorizado: "ITAU" }, endpointId: "endpoint-itau", prioridade: 5 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "AGUARDANDO_ROTEAMENTO", bancoAutorizado: "C6" });

    await runRoutingWorkerOnce({ routingPort: repo });

    expect(repo.offers.get(offer.id)?.status).toBe("SEM_ROTA_CONFIGURADA");
  });

  it("reprocessa SEM_ROTA_CONFIGURADA automaticamente quando uma regra compatível é cadastrada", async () => {
    const repo = new InMemoryPipelineRepository();
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "SEM_ROTA_CONFIGURADA", bancoAutorizado: "BMG" });

    // primeiro ciclo: ainda sem regra
    await runRoutingWorkerOnce({ routingPort: repo });
    expect(repo.offers.get(offer.id)?.status).toBe("SEM_ROTA_CONFIGURADA");

    // administrador cadastra a regra
    repo.addEndpoint({
      id: "endpoint-bmg",
      nome: "BMG",
      url: "https://example.com/bmg",
      metodoHttp: "POST",
      headers: null,
      authType: "NONE",
      credenciaisRef: null,
      capacidadeMinuto: null,
      capacidadeHora: 100,
      capacidadeDia: null,
      timeoutMs: 5000,
      maxTentativas: 3,
      ativo: true,
    });
    repo.addRule({ id: "rule-bmg", condicoes: { bancoAutorizado: "BMG" }, endpointId: "endpoint-bmg", prioridade: 10 });

    await runRoutingWorkerOnce({ routingPort: repo });
    expect(repo.offers.get(offer.id)?.status).toBe("AGUARDANDO_ENVIO");
  });

  it("trata regra para endpoint desativado como sem rota válida", async () => {
    const repo = new InMemoryPipelineRepository();
    repo.addEndpoint({
      id: "endpoint-inativo",
      nome: "Inativo",
      url: "https://example.com",
      metodoHttp: "POST",
      headers: null,
      authType: "NONE",
      credenciaisRef: null,
      capacidadeMinuto: null,
      capacidadeHora: 100,
      capacidadeDia: null,
      timeoutMs: 5000,
      maxTentativas: 3,
      ativo: false,
    });
    repo.addRule({ id: "rule-x", condicoes: {}, endpointId: "endpoint-inativo", prioridade: 10 });
    const offer = repo.addOffer({ telefoneOriginal: "62999999999", status: "AGUARDANDO_ROTEAMENTO" });

    await runRoutingWorkerOnce({ routingPort: repo });

    expect(repo.offers.get(offer.id)?.status).toBe("SEM_ROTA_CONFIGURADA");
  });
});
