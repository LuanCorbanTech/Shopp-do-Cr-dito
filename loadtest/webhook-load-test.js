// Teste de carga do webhook de ingestão — k6 (https://k6.io).
//
// NÃO foi executado neste repositório: exigiria a API rodando contra um Postgres/
// Redis reais e um webhook de teste já cadastrado (ver seed em
// packages/database/prisma/seed.ts), infraestrutura que só existe quando o projeto
// é implantado. Este script é o ponto de partida documentado para a Fase 9 do plano
// (seção 12 do doc de arquitetura) — rodar com:
//
//   WEBHOOK_SECRET=<secret do seed> BASE_URL=http://localhost:3000 \
//     k6 run loadtest/webhook-load-test.js
//
// O que validar ao rodar de verdade:
// - Latência do webhook deve continuar baixa mesmo sob carga (ele só grava no banco,
//   não deveria degradar com o volume — se degradar, é sinal de índice faltando ou
//   contenção na tabela `offers`).
// - Nenhuma oferta duplicada mesmo com IDs de idempotência repetidos de propósito.
// - Taxa de erro (4xx/5xx) deve ficar em ~0% para requisições assinadas corretamente.

import http from "k6/http";
import crypto from "k6/crypto";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const WEBHOOK_IDENTIFICADOR = __ENV.WEBHOOK_IDENTIFICADOR || "origem-teste";
const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || "troque-por-um-secret-real";

export const options = {
  scenarios: {
    ramping_offers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },
        { duration: "1m", target: 100 },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<300"], // webhook deve responder rápido (item 3 do escopo)
    http_req_failed: ["rate<0.01"],
  },
};

function sign(secret, timestamp, rawBody) {
  return crypto.hmac("sha256", secret, `${timestamp}.${rawBody}`, "hex");
}

export default function () {
  const body = JSON.stringify({
    telefone: `629${String(Math.floor(Math.random() * 100000000)).padStart(8, "0")}`,
    banco_autorizado: ["C6", "ITAU", "BMG"][Math.floor(Math.random() * 3)],
    external_id: `loadtest-${__VU}-${__ITER}`,
    produto: "emprestimo",
    valor: 1000 + Math.random() * 5000,
    parcelas: 12,
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(WEBHOOK_SECRET, timestamp, body);

  const response = http.post(`${BASE_URL}/webhooks/ofertas/${WEBHOOK_IDENTIFICADOR}`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Ofertas-Timestamp": timestamp,
      "X-Ofertas-Signature": signature,
    },
  });

  check(response, {
    "status é 200 ou 201": (r) => r.status === 200 || r.status === 201,
  });
}
