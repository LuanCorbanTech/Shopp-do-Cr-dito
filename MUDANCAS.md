# Novo endpoint: buscar dados de um lead pelo telefone

## O que foi pedido

Um `GET` que recebe um telefone, procura nas ofertas, e devolve os dados
que já temos daquele lead (CPF, nome, etc.) — pra um sistema externo saber
"quem é esse número" quando recebe uma mensagem.

## Decisões confirmadas com você antes de implementar

1. **Autenticação**: mesmo token dos outros 2 endpoints de disparo
   (`DISPATCH_API_TOKEN`, `Authorization: Bearer ...`) — não é uma chave
   por time, é o mesmo sistema externo único que já usa
   `/aguardando-disparo` e `/status`.
2. **Telefone com mais de uma oferta**: devolve só a **mais recente**.

## Como usar

```
GET /api/v1/leads/buscar-por-telefone?telefone=5562993718537
Authorization: Bearer <DISPATCH_API_TOKEN>
```

Aceita o telefone em qualquer formato razoável — com ou sem `+`, com ou sem
DDI, com espaços/parênteses/traço (`+55 (62) 99371-8537` funciona igual a
`5562993718537`).

**Resposta (200)** — mesmo formato de campos do `/aguardando-disparo`, mais
o `status` atual:
```json
{
  "id": "...", "externalId": "...", "nome": "...", "cpf": "...",
  "dataNascimento": "...", "telefoneWhatsapp": "...", "possuiWhatsapp": true,
  "bancoAutorizado": "...", "produto": "...", "valor": 5000, "parcelas": 12,
  "status": "DISPARO_RESPONDIDO"
}
```

**Se não achar nada**: `404 {"error": "nao_encontrado"}`

## Como a busca funciona

Compara contra `telefoneValidado` e `telefoneAtualizado` (os campos que o
pipeline efetivamente confirma) — não compara `telefoneOriginal` (valor cru
recebido do parceiro, sem garantia de formato).

## Validação

- **7 testes novos** (encontra oferta, telefone sem DDI, telefone com
  formatação solta, 404 quando não acha, 400 sem telefone, 401 token
  errado, 503 token não configurado).
- **69 testes no total** (suíte inteira da API), todos passando.
- Testei a query SQL exata (mais recente entre várias, ignorando telefone
  diferente) com **Postgres real**, do zero: 3 ofertas com o mesmo
  telefone em datas diferentes — confirmou que pega certinho a mais
  recente.
- `tsc --noEmit` limpo (precisei recompilar o pacote `domain` pra API
  enxergar a interface nova).

## Arquivos alterados

- `apps/api/src/leads/buscar-por-telefone-routes.ts` (novo)
- `apps/api/src/leads/buscar-por-telefone-routes.test.ts` (novo)
- `apps/api/src/leads/fake-dispatch-poll-port.ts`
- `apps/api/src/server.ts`
- `packages/domain/src/ports/pipeline-ports.ts`
- `packages/database/src/repositories/prisma-pipeline-repository.ts`

Nenhuma migração de banco — usa colunas e índice que já existiam.
