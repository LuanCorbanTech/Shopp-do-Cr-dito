import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();

// Cria um webhook de teste para desenvolvimento local (Fase 1).
// Rode com: npm run seed --workspace=@plataforma-ofertas/database
async function main() {
  const identificador = "origem-teste";
  const secret = process.env.SEED_WEBHOOK_SECRET ?? randomBytes(32).toString("hex");

  const webhook = await prisma.webhook.upsert({
    where: { identificador },
    update: { ativo: true },
    create: {
      identificador,
      origem: "Origem de teste (seed)",
      secretHmac: secret,
      ativo: true,
    },
  });

  console.log("Webhook de teste pronto:");
  console.log(`  identificador: ${webhook.identificador}`);
  console.log(`  url:           POST /webhooks/ofertas/${webhook.identificador}`);
  console.log(`  secret HMAC:   ${webhook.secretHmac}`);
  console.log("\nGuarde o secret para assinar as requisições de teste (ver README).");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
