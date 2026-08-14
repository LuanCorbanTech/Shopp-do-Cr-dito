// A Lemit (api.lemit.com.br, consultada pelo Worker 1 via packages/integrations/limit)
// devolve, por CPF, uma lista de celulares conhecidos da pessoa — cada um com um
// "ranking" (1 = melhor, segundo o critério deles) e uma flag "whatsapp" própria.
// Esta é a decisão pura de QUAL desses candidatos usar como telefoneAtualizado do
// lead: preferimos o de melhor ranking que já venha marcado com whatsapp=true;
// na falta de algum assim, caímos pro de melhor ranking mesmo assim.
//
// Importante: essa escolha é só um palpite pra decidir qual número tentar primeiro.
// A validação OFICIAL de WhatsApp (Worker 2, via API da CorbanTech) roda de qualquer
// forma depois em cima do número escolhido aqui — é ela quem decide o resultado
// final, não a Lemit.

export interface LemitCelular {
  ddd: number;
  numero: string;
  ranking: number;
  whatsapp: boolean;
}

export interface TelefoneEscolhidoLemit {
  /** Com DDI 55 (Brasil), no mesmo formato usado no resto do pipeline (ex.: "5562999999999"). */
  telefone: string;
  /** Segundo a própria Lemit — informativo, não substitui a validação oficial do Worker 2. */
  possuiWhatsappSegundoLemit: boolean;
}

export function escolherMelhorTelefoneLemit(celulares: unknown): TelefoneEscolhidoLemit | null {
  if (!Array.isArray(celulares) || celulares.length === 0) return null;

  const validos = celulares.filter(isLemitCelular);
  if (validos.length === 0) return null;

  const ordenadosPorRanking = [...validos].sort((a, b) => a.ranking - b.ranking);
  const escolhido = ordenadosPorRanking.find((c) => c.whatsapp) ?? ordenadosPorRanking[0];

  return {
    telefone: `55${escolhido.ddd}${escolhido.numero}`,
    possuiWhatsappSegundoLemit: escolhido.whatsapp,
  };
}

function isLemitCelular(value: unknown): value is LemitCelular {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return typeof c.ddd === "number" && typeof c.numero === "string" && typeof c.ranking === "number" && typeof c.whatsapp === "boolean";
}
