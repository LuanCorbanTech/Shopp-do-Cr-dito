# Correção: "Horário com maior taxa de resposta" com o horário errado

Este zip é **incremental** — pressupõe que os três zips anteriores (redesign do
Dashboard, colunas de horário + fuso, e a integração de Relatório periódico) já
foram aplicados. Contém só o arquivo alterado desta rodada.

## O que foi reportado

No card "Horário com maior taxa de resposta" do Dashboard, o pico aparecia às
21:00 — mas esse não era o horário real de maior resposta; o valor certo
deveria ser mais cedo.

## O que eu encontrei

Confirmado: é o mesmo tipo de bug de fuso horário já corrigido no painel (zip
"colunas de horário e fuso"), só que dessa vez direto na consulta SQL, não na
formatação.

A coluna `disparo_respondido_em` no banco é do tipo `timestamp` **sem** fuso
horário (`timestamp(3)`, o padrão do Prisma quando não se especifica
`@db.Timestamptz`) — ela guarda o valor exatamente como o Node grava, que é
sempre em UTC. O problema é que a consulta antiga fazia:

```sql
EXTRACT(HOUR FROM disparo_respondido_em)
```

Isso lê a hora **literal** gravada na coluna — ou seja, a hora em UTC — sem
converter pra Brasília. Como Brasília é UTC-3 (fixo, sem horário de verão desde
2019), toda hora mostrada nesse card vinha **3 horas adiantada** em relação à
hora real de Brasília.

Isso bate exatamente com o que foi reportado: um pico verdadeiro às **18:00**
em Brasília ficava gravado no banco como **21:00** (18:00 + 3h = 21:00 em
UTC), e a consulta antiga lia esse "21" direto, sem converter de volta —
exibindo 21:00 como se fosse o horário de pico real, quando na verdade era o
horário em UTC do que aconteceu às 18:00 em Brasília.

## A correção

Troquei a consulta em `dashboardHorarioResposta`
(`packages/database/src/repositories/admin-repository.ts`) para converter
explicitamente pra `America/Sao_Paulo` antes de extrair a hora:

```sql
EXTRACT(HOUR FROM (disparo_respondido_em AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo'))::int
```

- `AT TIME ZONE 'UTC'` reinterpreta o valor gravado como o instante UTC que ele
  já é (transforma num `timestamptz` de verdade).
- `AT TIME ZONE 'America/Sao_Paulo'` projeta esse instante no horário de
  parede de Brasília.
- Só então o `EXTRACT(HOUR FROM ...)` lê a hora certa.

Nenhuma outra parte dessa consulta (o filtro de período `from`/`to`, que
compara instantes absolutos) precisou mudar — só o agrupamento por "hora do
dia" é que dependia do fuso.

## Sobre os outros gráficos do Dashboard (aviso, não corrigido ainda)

Ao procurar por esse mesmo tipo de problema no restante do arquivo, encontrei
que os 3 gráficos de **série diária** (evolução dia a dia) fazem a mesma coisa
com o dia, em vez da hora — usam `date_trunc('day', coluna)` direto na coluna
em UTC, sem converter pra Brasília:

- `dashboardTimeseries` (Recebidas × Processadas)
- `dashboardEnviadosVsRespondidos` (Disparo Enviado × Respondido)
- `dashboardRecebidasVsEnviados` (Recebidas × Enviados)

Na prática, o efeito aqui é bem menor: só ofertas que acontecem entre 21h e
23h59 em Brasília (0h-2h59 em UTC do dia seguinte) correriam o risco de cair no
dia seguinte do gráfico em vez do dia certo — não muda quantidades totais, só
pode deslocar uma oferta perto da virada da meia-noite para o dia ao lado no
gráfico. Não mexi nisso agora porque não foi o que foi reportado e é uma
mudança que eu não consigo testar de ponta a ponta neste ambiente (não tenho
acesso a um Postgres de verdade aqui para comparar o resultado antes/depois).
Se quiser, posso aplicar a mesma correção nesses 3 gráficos também — é o
mesmo padrão de `AT TIME ZONE`.

## Arquivo alterado (1)

| Caminho | O que mudou |
|---|---|
| `packages/database/src/repositories/admin-repository.ts` | `dashboardHorarioResposta`: a hora agora é extraída já convertida pra `America/Sao_Paulo`, em vez da hora crua em UTC. |

## Validação

Como nos zips anteriores, não consigo rodar `prisma generate` neste ambiente
de geração (`binaries.prisma.sh` bloqueado), então não dá pra compilar 100%
este pacote aqui nem testar contra um banco de verdade. Rodei `npx tsc
--noEmit` mesmo assim e conferi que os erros na função alterada são exatamente
a mesma categoria (`Prisma.sql`/`Prisma.empty` não resolvidos, porque o client
do Prisma não foi gerado neste ambiente) que já existia nas outras consultas
raw SQL do mesmo arquivo, intocadas — nenhum erro novo ou de tipo diferente
apareceu. É uma mudança puramente de SQL (a sintaxe `AT TIME ZONE` é padrão do
Postgres), então deve compilar e rodar normalmente no seu ambiente (CI/local),
onde o Prisma consegue gerar o client.

**Nenhuma migração de banco necessária** — é só uma mudança na consulta, a
coluna continua exatamente a mesma.
