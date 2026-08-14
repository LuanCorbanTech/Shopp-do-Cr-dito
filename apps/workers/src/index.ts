import { logger } from "@plataforma-ofertas/shared";

// Placeholder da Fase 0. Os 6 workers reais (seção 6.1 do doc de arquitetura) entram
// a partir da Fase 2:
//   1. Processamento inicial (Limit)      -> Fase 2
//   2. Validação WhatsApp                  -> Fase 3
//   3. Roteamento                          -> Fase 4
//   4. Disparo                             -> Fase 5
//   5. Retry                               -> Fase 6
//   6. Reconciliação                       -> Fase 6
//
// Cada worker deverá ser um entrypoint próprio (ou processo BullMQ dedicado),
// para poder escalar/reiniciar independentemente em produção.

logger.info("Workers ainda não implementados — ver plano de fases no doc de arquitetura.");
