// Cliente da API da Odysseia — hoje só a rota de ligar/desligar entrega
// (PATCH /v1/webhook/active). Isolado num arquivo próprio (não dentro do
// worker de tarefas) pra ficar fácil adicionar um fornecedor novo depois:
// cada um ganha seu próprio arquivo aqui, com a MESMA assinatura de função
// (apiKey, ativo) => Promise<void>, e o worker de tarefas escolhe qual
// chamar pelo campo "fornecedor" da tarefa.

export interface DefinirAtivoParams {
  apiKey: string;
  ativo: boolean;
  fetchImpl?: typeof fetch;
}

export class ErroAtivarFornecedor extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = "ErroAtivarFornecedor";
  }
}

export async function definirAtivoOdysseia(params: DefinirAtivoParams): Promise<void> {
  const { apiKey, ativo, fetchImpl = fetch } = params;
  const resposta = await fetchImpl("https://api.odysseia.app/api/v1/webhook/active", {
    method: "PATCH",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ active: ativo }),
  });
  if (!resposta.ok) {
    const texto = await resposta.text().catch(() => "");
    throw new ErroAtivarFornecedor(
      `Odysseia respondeu ${resposta.status} ao tentar ${ativo ? "ligar" : "desligar"} o recebimento: ${texto.slice(0, 300)}`,
      resposta.status
    );
  }
}
