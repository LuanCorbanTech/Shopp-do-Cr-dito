import type {
  OffersPort,
  WebhookRecord,
  CreateOfferInput,
  CreateOfferResult,
  OfferRecord,
} from "@plataforma-ofertas/domain";

// Mesma janela usada pela implementação real (ver prisma-offers-port.ts) —
// pedido explícito 14/09: mesmo webhook+CPF dentro de 24h da última vez
// ACEITO (criado ou resetado, nunca um descarte) descarta; passou de 24h,
// reseta e deixa entrar no fluxo de novo.
const JANELA_DESCARTE_MS = 24 * 60 * 60 * 1000;

/** Um evento de descarte, no formato equivalente a WebhookLeadDescartado. */
export interface DescarteRegistrado {
  webhookId: string;
  criadoEm: Date;
}

// Implementação em memória de OffersPort, usada só em testes — permite testar
// handler.ts (idempotência, validação, roteamento de erros, descarte por 24h)
// sem subir Postgres. Usa Date.now() de verdade (controlável em teste com
// vi.useFakeTimers()/vi.setSystemTime()) pra decidir a janela de 24h — igual
// a implementação real usa now() do Postgres.
export function createFakeOffersPort(webhooks: WebhookRecord[]): {
  port: OffersPort;
  offersByKey: Map<string, OfferRecord>;
  offersByCpf: Map<string, OfferRecord>;
  descartes: DescarteRegistrado[];
} {
  const offersByKey = new Map<string, OfferRecord>();
  const offersByCpf = new Map<string, OfferRecord>();
  // Data/hora da última vez que cada (webhook, CPF normalizado) foi ACEITO
  // (criado ou resetado) — espelha Offer.ultimoRecebimentoWebhookEm.
  const ultimoAceitoPorCpf = new Map<string, number>();
  const descartes: DescarteRegistrado[] = [];
  let counter = 0;

  const port: OffersPort = {
    async findActiveWebhookByIdentificador(identificador: string) {
      const webhook = webhooks.find((w) => w.identificador === identificador);
      if (!webhook || !webhook.ativo) return null;
      return webhook;
    },

    async createOfferIdempotent(input: CreateOfferInput): Promise<CreateOfferResult> {
      // Normaliza o CPF (só dígitos) antes de comparar, senão
      // "123.456.789-00" e "12345678900" (mesmo CPF, formatação diferente
      // entre uma chamada e outra) seriam tratados como CPFs diferentes —
      // igual a implementação real faz com regexp_replace.
      const cpfNormalizado = input.cpf.replace(/\D/g, "");
      const cpfKey = `${input.webhookId}:${cpfNormalizado}`;
      const existentePorCpf = offersByCpf.get(cpfKey);

      if (existentePorCpf) {
        const agora = Date.now();
        const ultimoAceito = ultimoAceitoPorCpf.get(cpfKey) ?? 0;
        if (agora - ultimoAceito < JANELA_DESCARTE_MS) {
          // Dentro de 24h da última vez aceito — descarta, sem tocar em
          // nada da oferta existente (nenhum progresso é perdido). Um
          // descarte NUNCA atualiza ultimoAceitoPorCpf (pedido explícito:
          // "a contagem fica sendo a última que ele de fato passou pelo
          // funil").
          descartes.push({ webhookId: input.webhookId, criadoEm: new Date(agora) });
          return { kind: "discarded" };
        }

        // Passou de 24h — reseta (nunca duplica), mesma regra de antes.
        const resetada: OfferRecord = {
          ...existentePorCpf,
          idempotencyKey: input.idempotencyKey,
          status: "RECEBIDO",
        };
        offersByCpf.set(cpfKey, resetada);
        offersByKey.set(`${input.webhookId}:${input.idempotencyKey}`, resetada);
        ultimoAceitoPorCpf.set(cpfKey, agora);
        return { offer: resetada, kind: "reset" };
      }

      const compoundKey = `${input.webhookId}:${input.idempotencyKey}`;
      const existing = offersByKey.get(compoundKey);
      if (existing) {
        return { offer: existing, kind: "duplicate" };
      }
      counter += 1;
      const offer: OfferRecord = {
        id: `offer-${counter}`,
        webhookId: input.webhookId,
        idempotencyKey: input.idempotencyKey,
        status: "RECEBIDO",
        createdAt: new Date(0),
      };
      offersByKey.set(compoundKey, offer);
      offersByCpf.set(cpfKey, offer);
      ultimoAceitoPorCpf.set(cpfKey, Date.now());
      return { offer, kind: "created" };
    },
  };

  return { port, offersByKey, offersByCpf, descartes };
}
