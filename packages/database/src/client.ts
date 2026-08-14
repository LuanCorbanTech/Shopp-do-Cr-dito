import { PrismaClient } from "@prisma/client";

// Singleton do Prisma Client, compartilhado entre API e workers.
// Evita esgotar conexões do Postgres quando múltiplos processos/workers sobem.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}

export * from "@prisma/client";
