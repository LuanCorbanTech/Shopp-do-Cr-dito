import { describe, expect, it } from "vitest";
import { avaliarPioraQualidade } from "./qualidade-whatsapp";

describe("avaliarPioraQualidade", () => {
  it("número novo (sem anterior) nunca é piora", () => {
    const resultado = avaliarPioraQualidade(null, { qualityRating: "RED" });
    expect(resultado.piorou).toBe(false);
    expect(resultado.motivo).toBeNull();
  });

  it("detecta queda de GREEN para YELLOW", () => {
    const resultado = avaliarPioraQualidade({ qualityRating: "GREEN" }, { qualityRating: "YELLOW" });
    expect(resultado.piorou).toBe(true);
    expect(resultado.motivo).toContain("GREEN");
    expect(resultado.motivo).toContain("YELLOW");
  });

  it("detecta queda de YELLOW para RED", () => {
    const resultado = avaliarPioraQualidade({ qualityRating: "YELLOW" }, { qualityRating: "RED" });
    expect(resultado.piorou).toBe(true);
  });

  it("não considera piora quando a qualidade melhora (RED -> GREEN)", () => {
    const resultado = avaliarPioraQualidade({ qualityRating: "RED" }, { qualityRating: "GREEN" });
    expect(resultado.piorou).toBe(false);
  });

  it("perder o rating e virar UNKNOWN conta como piora", () => {
    const resultado = avaliarPioraQualidade({ qualityRating: "GREEN" }, { qualityRating: "UNKNOWN" });
    expect(resultado.piorou).toBe(true);
  });

  it("começar em UNKNOWN e virar YELLOW não é piora", () => {
    const resultado = avaliarPioraQualidade({ qualityRating: "UNKNOWN" }, { qualityRating: "YELLOW" });
    expect(resultado.piorou).toBe(false);
  });

  it("mesma qualidade não é piora", () => {
    const resultado = avaliarPioraQualidade({ qualityRating: "GREEN" }, { qualityRating: "GREEN" });
    expect(resultado.piorou).toBe(false);
  });

  it("detecta queda de tier reconhecido", () => {
    const resultado = avaliarPioraQualidade(
      { qualityRating: "GREEN", messagingLimitTier: "TIER_10K" },
      { qualityRating: "GREEN", messagingLimitTier: "TIER_250" }
    );
    expect(resultado.piorou).toBe(true);
    expect(resultado.motivo).toContain("TIER_10K");
  });

  it("subida de tier não é piora", () => {
    const resultado = avaliarPioraQualidade(
      { qualityRating: "GREEN", messagingLimitTier: "TIER_250" },
      { qualityRating: "GREEN", messagingLimitTier: "TIER_10K" }
    );
    expect(resultado.piorou).toBe(false);
  });

  it("tier desconhecido (não mapeado) nunca gera falso positivo", () => {
    const resultado = avaliarPioraQualidade(
      { qualityRating: "GREEN", messagingLimitTier: "TIER_NOVO_DA_META" },
      { qualityRating: "GREEN", messagingLimitTier: "TIER_250" }
    );
    expect(resultado.piorou).toBe(false);
  });

  it("detecta status novo virando FLAGGED", () => {
    const resultado = avaliarPioraQualidade(
      { qualityRating: "GREEN", status: "CONNECTED" },
      { qualityRating: "GREEN", status: "FLAGGED" }
    );
    expect(resultado.piorou).toBe(true);
    expect(resultado.motivo).toContain("FLAGGED");
  });

  it("status que já era ruim não dispara alerta de novo", () => {
    const resultado = avaliarPioraQualidade(
      { qualityRating: "GREEN", status: "FLAGGED" },
      { qualityRating: "GREEN", status: "FLAGGED" }
    );
    expect(resultado.piorou).toBe(false);
  });

  it("combina motivos quando mais de um piora ao mesmo tempo", () => {
    const resultado = avaliarPioraQualidade(
      { qualityRating: "GREEN", messagingLimitTier: "TIER_10K", status: "CONNECTED" },
      { qualityRating: "RED", messagingLimitTier: "TIER_50", status: "FLAGGED" }
    );
    expect(resultado.piorou).toBe(true);
    expect(resultado.motivo?.split("; ")).toHaveLength(3);
  });
});
