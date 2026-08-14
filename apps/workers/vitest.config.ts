import { defineConfig } from "vitest/config";
import path from "node:path";

// Aponta os pacotes do workspace direto para o código-fonte (em vez de dist/),
// para os testes não dependerem da ordem de build — útil também porque o Prisma
// Client (usado por @plataforma-ofertas/database) não pode ser gerado neste
// ambiente de sandbox (ver README); os workers testados aqui não importam
// @plataforma-ofertas/database, então isso não é necessário para eles.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "@plataforma-ofertas/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@plataforma-ofertas/domain": path.resolve(__dirname, "../../packages/domain/src/index.ts"),
      "@plataforma-ofertas/queue": path.resolve(__dirname, "../../packages/queue/src/index.ts"),
    },
  },
});
