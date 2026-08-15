import {
  decideWhatsappCheckFailureOutcome,
  DEFAULT_BACKOFF_SCHEDULE_SECONDS,
  DEFAULT_MAX_TENTATIVAS,
  type WhatsappValidationPort,
  type IntegrationConfigPort,
} from "@plataforma-ofertas/domain";

// Recebe o callback da API de Validação de WhatsApp da CorbanTech (seção 03 da
// documentação: docs/integrations/APIValidacaoWhatsAppCorbanTech.pdf). A CorbanTech
// não assina a requisição (sem HMAC) — a segurança recomendada por eles é embutir
// um código secreto na própria URL de callback cadastrada no painel deles, e
// conferir esse código aqui (ver seção "Segurança do webhook" do doc). Por isso o
// token vem via querystring (?token=...), não via header.
//
// É "caminho rápido": o mesmo resultado também é buscado manualmente pelo Worker 2
// (apps/workers/src/workers/worker2-whatsapp.ts) se este webhook não chegar a tempo
// — então esse handler não precisa ser a única forma da oferta avançar.

export interface WhatsappValidacaoWebhookBody {
  request_id: string;
  phone?: string;
  has_whatsapp?: boolean;
  error?: boolean;
  message?: string;
}

export type WhatsappValidacaoWebhookOutcome =
  | { kind: "processed"; offerId: string }
  | { kind: "invalid_token" }
  | { kind: "request_id_ausente" }
  | { kind: "oferta_nao_encontrada" };

export async function handleWhatsappValidacaoWebhook(
  port: WhatsappValidationPort,
  configPort: IntegrationConfigPort,
  params: {
    token: string | undefined;
    expectedToken: string;
    body: WhatsappValidacaoWebhookBody;
    now?: Date;
  }
): Promise<WhatsappValidacaoWebhookOutcome> {
  if (!params.token || params.token !== params.expectedToken) {
    return { kind: "invalid_token" };
  }
  if (!params.body.request_id) {
    return { kind: "request_id_ausente" };
  }

  const offer = await port.findOfferByWhatsappRequestId(params.body.request_id);
  if (!offer) {
    // Pode acontecer se o callback chegar depois da oferta já ter sido finalizada
    // pelo fallback manual do Worker 2 (whatsappRequestId já foi limpo nesse caso).
    // Não é um erro do lado da CorbanTech — respondemos 200 mesmo assim (ver rota).
    return { kind: "oferta_nao_encontrada" };
  }

  const telefoneUsado = offer.telefoneAtualizado ?? offer.telefoneOriginal;

  // Mesma proteção do Worker 2 (worker2-whatsapp.ts): se por algum motivo não
  // existir telefone nenhum associado a essa oferta, cancela de forma explícita
  // em vez de gravar um telefone vazio. Ainda responde 200 pra CorbanTech —
  // o problema é nosso, não deles.
  if (!telefoneUsado) {
    await port.markWhatsappFailed(offer.id, {
      erro: "Callback da CorbanTech chegou, mas a oferta não tem nenhum telefone registrado.",
      tentativa: offer.tentativasWhatsapp + 1,
      proximaTentativaEm: null,
      cancelar: true,
    });
    return { kind: "processed", offerId: offer.id };
  }

  if (params.body.error) {
    const config = await configPort.getConfig("WHATSAPP_VALIDACAO");
    const maxTentativas = Number(config?.valor.maxTentativas ?? DEFAULT_MAX_TENTATIVAS);
    const schedule = Array.isArray(config?.valor.backoffSecondsSchedule)
      ? (config!.valor.backoffSecondsSchedule as number[])
      : DEFAULT_BACKOFF_SCHEDULE_SECONDS;
    const outcome = decideWhatsappCheckFailureOutcome({
      tentativaAtual: offer.tentativasWhatsapp,
      maxTentativas,
      backoffSchedule: schedule,
      now: params.now,
    });
    await port.markWhatsappFailed(offer.id, {
      erro: params.body.message ?? "Validação de WhatsApp retornou erro",
      tentativa: outcome.tentativa,
      proximaTentativaEm: outcome.proximaTentativaEm,
      cancelar: outcome.cancelar,
      respostaBruta: params.body,
    });
  } else {
    await port.markWhatsappValidated(offer.id, {
      possuiWhatsapp: Boolean(params.body.has_whatsapp),
      respostaBruta: params.body,
      telefoneUsado,
    });
  }

  return { kind: "processed", offerId: offer.id };
}
