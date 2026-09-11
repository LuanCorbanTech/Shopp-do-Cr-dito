// Utilitário genérico (11/09) — nasceu de um bug real: o webhook de ofertas
// processava um lote inteiro de leads em SÉRIE (um de cada vez, esperando
// cada gravação no banco terminar antes de começar a próxima). Com lotes
// grandes (ex.: 495 leads de uma vez, ~900KB), isso passava dos 50 segundos
// de timeout do parceiro (Odysseia) — que aí reenviava o LOTE INTEIRO de
// novo, fazendo leads que já tinham acabado de validar WhatsApp perderem
// esse progresso (ver createOfferIdempotent: mesmo parceiro + mesmo CPF =
// reseta a oferta pro início do funil).
//
// mapWithConcurrencyLimit roda `fn` pra cada item, no máximo `limit` de cada
// vez — nem tudo em série (lento demais pra lotes grandes) nem tudo de uma
// vez só (podia esgotar o pool de conexões do banco). O resultado sai na
// MESMA ORDEM da entrada, não na ordem de conclusão (importante pra quem
// depende da posição do resultado pra saber a qual item ele corresponde).
export async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  let proximoIndice = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const indice = proximoIndice;
      proximoIndice += 1;
      if (indice >= items.length) return;
      resultados[indice] = await fn(items[indice], indice);
    }
  }

  const quantidadeWorkers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: quantidadeWorkers }, () => worker()));
  return resultados;
}
