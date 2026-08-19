# API de Validação de WhatsApp — CorbanTech

Esta API permite que o seu sistema consulte, número a número, se um
telefone tem WhatsApp ativo ou não — pensada para uso ao longo do dia,
conforme os números forem chegando (não é necessário juntar em lote).

## Como funciona (leia antes de integrar)

A verificação passa por um serviço de terceiros que **não responde
instantaneamente** — por isso, e também porque nossa hospedagem derruba
qualquer requisição que demore demais, a API funciona em duas etapas:

1. Você envia o número (`POST`). A resposta vem **na hora** (poucos
   milissegundos), só confirmando que a consulta foi recebida — ainda
   **sem o resultado**.
2. Quando o resultado sai (geralmente em alguns segundos, podendo levar
   até um pouco mais de um minuto em casos raros), você recebe de volta
   de uma destas duas formas:
   - **Webhook** (recomendado): se você cadastrar uma URL de callback, a
     CorbanTech chama essa URL automaticamente com o resultado assim que
     sair. Você não precisa ficar consultando nada.
   - **Consulta manual (GET)**: a qualquer momento, você pode consultar o
     resultado pelo `request_id` recebido no passo 1. Útil como plano B,
     caso o seu endpoint de webhook esteja fora do ar no momento da
     entrega.

## Autenticação

Toda chamada precisa do header `X-API-Key` com a credencial do seu time.
A credencial é gerada e entregue pela CorbanTech — é individual por
time e não deve ser compartilhada.

```
X-API-Key: cbk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Se a chave for revogada ou substituída por uma nova, as chamadas com a
chave antiga passam a retornar erro `401` imediatamente.

## Webhook (URL de callback)

Você pode cadastrar uma URL padrão com a CorbanTech (fica salva no seu
time e vale pra todas as consultas) e/ou informar uma URL específica em
cada chamada, no campo `callback_url` — se informado, ele tem prioridade
sobre a URL padrão do time só naquela consulta.

Quando o resultado sair, a CorbanTech faz um `POST` para essa URL:

**Sucesso:**

```json
{
  "request_id": "a1b2c3d4e5f6a7b8c9",
  "phone": "5511999999999",
  "has_whatsapp": true
}
```

**Falha na validação:**

```json
{
  "request_id": "a1b2c3d4e5f6a7b8c9",
  "phone": "5511999999999",
  "error": true,
  "message": "Não foi possível validar esse número agora. Tente enviar uma nova consulta."
}
```

A CorbanTech tenta entregar o webhook **uma vez**, com um tempo de espera
curto. Se o seu endpoint estiver fora do ar ou demorar demais pra
responder, a entrega é considerada falha — nesse caso, use a consulta
manual (GET) abaixo pra recuperar o resultado; ele fica disponível por
14 dias.

Se você quiser autenticar as chamadas que chegam nesse webhook (confirmar
que realmente veio da CorbanTech), a forma mais simples é incluir um
código secreto seu como parte da própria URL cadastrada (ex.:
`https://seusistema.com/webhook/whatsapp?token=SEU_CODIGO_SECRETO`) e
validar esse token do seu lado — a CorbanTech chama exatamente a URL que
você cadastrou, sem alterá-la.

## Endpoints

### `POST /api/v1/whatsapp/check` — inicia uma consulta

**Corpo da requisição (JSON):**

| Campo          | Obrigatório | Descrição                                                                          |
|----------------|:---:|----------------------------------------------------------------------------------------------|
| `phone`        | sim | Número de telefone, com ou sem o código do país. Só dígitos são considerados (pode mandar com parênteses, traço, espaço, "+" etc. — tudo isso é ignorado). |
| `ddi`          | não | Código do país, caso `phone` não inclua o DDI. Padrão: `55` (Brasil).             |
| `callback_url` | não | URL de webhook só pra essa consulta — sobrescreve a URL padrão do time, se houver.  |

**Exemplo de requisição:**

```bash
curl -X POST https://SEU-DOMINIO/api/v1/whatsapp/check \
  -H "X-API-Key: cbk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"phone": "11999999999"}'
```

**Resposta imediata (HTTP 202):**

```json
{
  "status": "processing",
  "request_id": "a1b2c3d4e5f6a7b8c9",
  "phone": "5511999999999"
}
```

Guarde o `request_id` — é ele que você usa pra consultar o resultado
depois (ou pra conferir o resultado recebido via webhook).

### `GET /api/v1/whatsapp/check/{request_id}` — consulta o resultado

**Exemplo:**

```bash
curl https://SEU-DOMINIO/api/v1/whatsapp/check/a1b2c3d4e5f6a7b8c9 \
  -H "X-API-Key: cbk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**Respostas possíveis (sempre HTTP 200):**

Ainda processando:
```json
{ "status": "processing", "request_id": "a1b2c3d4e5f6a7b8c9" }
```

Concluído:
```json
{ "status": "done", "request_id": "a1b2c3d4e5f6a7b8c9", "phone": "5511999999999", "has_whatsapp": true }
```

Falhou:
```json
{ "status": "error", "request_id": "a1b2c3d4e5f6a7b8c9", "message": "Não foi possível validar esse número agora. Tente enviar uma nova consulta." }
```

Só é possível consultar `request_id`s gerados pela sua própria
credencial. O registro fica disponível por 14 dias.

## Erros

| HTTP | Campo `error`          | O que significa                                                                 |
|:----:|------------------------|----------------------------------------------------------------------------------|
| 400  | `json_invalido`         | O corpo enviado não é um JSON válido.                                            |
| 400  | `telefone_ausente`      | O campo `phone` não foi enviado.                                                 |
| 400  | `telefone_invalido`     | O número enviado tem poucos dígitos para ser um telefone válido.                 |
| 400  | `callback_url_invalida` | O `callback_url` enviado não começa com `http://` ou `https://`.                 |
| 401  | `chave_ausente`         | O header `X-API-Key` não foi enviado.                                           |
| 401  | `chave_invalida`        | A credencial não existe, foi revogada, ou foi substituída por uma nova.         |
| 403  | `time_nao_elegivel`     | A credencial pertence a um time que não está mais no modelo pós-pago.           |
| 404  | `nao_encontrado`        | (só no GET) Esse `request_id` não existe ou não pertence à sua credencial.       |
| 429  | `limite_excedido`       | Limite de requisições por minuto atingido (ver "Limite de uso" abaixo).          |
| 503  | `servico_indisponivel`  | O serviço de validação ainda não foi configurado do lado da CorbanTech.          |

Todas as respostas de erro trazem também um campo `message` com um texto
pronto para exibir, se for o caso.

## Limite de uso (rate limit)

- **60 requisições por minuto** por credencial para iniciar consultas (`POST`).
- **120 requisições por minuto** por credencial para consultar status (`GET`) — um limite à parte, pra não competir com o de iniciar novas consultas.

Se algum desses limites for ultrapassado, a resposta vem com HTTP `429`
e um header `Retry-After` (em segundos) indicando quanto tempo esperar.

## Cobrança

Cada consulta feita por essa API consome 1 crédito do seu time (debitado
quando o resultado sai, com sucesso ou falha na validação), usando o
mesmo preço por crédito já contratado. O uso aparece separado no
relatório financeiro (fatura em PDF) como uma linha própria, "Consultas
via API (validação de WhatsApp)", distinta do uso do formatador de base.

## Consulta em LOTE (recomendado para alto volume)

Se o seu sistema tem volume alto (na prática, isso costuma valer a pena a
partir de algumas centenas de números por dia), a consulta em lote sai
**bem mais barata por número** que a consulta individual acima — em troca,
a resposta não é instantânea (pode levar alguns minutos).

### `POST /api/v1/whatsapp/check-lote`

```json
{
  "phones": ["11987654321", "21988887777", "..."],
  "ddi": "55",
  "callback_url": "https://seusite.com/webhook (opcional)"
}
```

- `phones` — array de números (com ou sem DDI, mesmas regras de formato da
  consulta individual). **Mínimo de 500 números por lote** — abaixo disso,
  a resposta é `400` com o erro `lote_muito_pequeno`.
- Resposta imediata (`202`): `{"status": "processing", "lote_id": "...", "total": 500}`

### `GET /api/v1/whatsapp/check-lote/:lote_id`

Igual à consulta individual (mesmo header `X-API-Key`), mas devolve o
array inteiro de resultados quando pronto:

```json
{
  "status": "done",
  "lote_id": "...",
  "total": 500,
  "resultados": [
    { "telefone": "5511987654321", "possui_whatsapp": true },
    { "telefone": "5521988887777", "possui_whatsapp": false }
  ]
}
```

Enquanto não terminar: `{"status": "processing", "lote_id": "...", "total": 500}`.
Se der erro: `{"status": "error", "lote_id": "...", "message": "..."}`.

Se `callback_url` for informado, o mesmo corpo do `GET` acima (com
`status: "done"` ou `"error"`) é enviado por `POST` assim que o lote
terminar — assim seu sistema não precisa ficar consultando (`GET`) o
tempo todo, só usar isso como plano B se o callback não chegar.

## Dúvidas

Fale com a CorbanTech pelos canais de contato de sempre.
