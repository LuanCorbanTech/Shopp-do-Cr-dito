# Nova integração: Relatório periódico (cron configurável)

Este zip é **incremental** — pressupõe que os dois zips anteriores (redesign do
Dashboard, e colunas de horário + correção de fuso) já foram aplicados. Contém só
os arquivos alterados/novos desta rodada.

## O que foi pedido

Uma nova integração no painel: uma cron cuja frequência é configurada pelo
próprio usuário (ex.: de 4 em 4 horas), que envia um relatório para um endpoint
que o usuário cadastra no painel. Requisição POST simples, com um único header
(`Content-Type: application/json`), e o corpo com 9 campos, sempre com os dados
de HOJE:

- Total de ofertas recebidas
- Aguardando processamento
- Com Lemit validado
- Com Whatsapp validado
- Aguardando consulta do disparo
- Com disparo consultado
- Disparo enviado
- Disparo respondido
- Taxa de resposta

## Como funciona

**1. Configuração (painel → Integrações → "Relatório periódico")**

Uma seção nova na página de Integrações, com:

- Botão Ativar/Desativar (mesmo padrão do toggle da Lemit).
- Campo para a URL do endpoint que vai receber o POST.
- Campo para a frequência de envio, em horas (ex.: `4` = de 4 em 4 horas — é só
  um exemplo, o número é livre).

Salvar aqui vale a partir do próximo ciclo do worker (poucos segundos) — não
precisa reiniciar nada no servidor, mesmo padrão das outras integrações.

**2. Onde fica guardado**

Reaproveita a mesma tabela `integration_configs` já usada pela Lemit e pelo
WhatsApp (nenhuma migração de banco necessária): uma nova chave
`RELATORIO_PERIODICO_WEBHOOK`, com `ativo` no campo já existente da tabela, e
`{ endpointUrl, intervaloHoras }` dentro do campo `valor` (JSON).

**3. O worker novo (worker7-relatorio-periodico)**

Roda no mesmo processo dos outros 6 workers (`apps/workers/src/index.ts`), com o
mesmo mecanismo de intervalo reconfigurável sem reiniciar (o `loop()` já
existente, que relê a frequência do banco a cada ciclo — igual ao que a Lemit e
o WhatsApp já fazem com o intervalo delas).

A cada ciclo:

1. Lê a config (`ativo`, `endpointUrl`) do banco. Se estiver desativado, não faz
   nada (nem calcula os números à toa).
2. Calcula o início do dia **em horário de Brasília** — não do servidor. Isso é
   importante: se o servidor rodar em UTC (comum em droplets), "hoje" pro
   servidor pode começar 3h antes de "hoje" em Brasília, o que faria o relatório
   contar um pedaço de ontem junto. Criei um helper novo pra isso
   (`packages/domain/src/fuso-horario.ts`, função `inicioDoDiaEmBrasilia`) —
   mesmo princípio já usado na correção de fuso do zip anterior, agora aplicado
   no lado do worker/backend. Ele usa `Intl.DateTimeFormat` pra descobrir o
   dia/mês/ano atual em Brasília (não depende do fuso do servidor) e monta a
   meia-noite de Brasília em UTC (00:00 BRT = 03:00 UTC, já que Brasília é
   UTC-3 fixo, sem horário de verão desde 2019).
3. Busca as contagens do dia usando a MESMA consulta que já alimenta os cards do
   Dashboard (`AdminRepository.dashboardKpis`) — não duplica lógica de contagem
   nova, só reaproveita a que já existe e já é usada e validada no Dashboard.
4. Monta o corpo com os 9 campos, calcula "Taxa de resposta" como
   `Disparo respondido / Disparo enviado` (fica `0`, não erro, se ainda não
   houve nenhum disparo enviado no dia).
5. Faz o POST pro endpoint cadastrado, com **só** o header
   `Content-Type: application/json` (nenhum header extra, como pedido).
6. Se o endpoint responder com erro ou estiver fora do ar, o worker só registra
   o erro no log e tenta de novo no próximo ciclo — nunca derruba o processo.

## Arquivos alterados (6)

| Caminho | O que mudou |
|---|---|
| `packages/domain/src/index.ts` | Passa a exportar o novo helper `fuso-horario.ts`. |
| `packages/database/src/repositories/admin-repository.ts` | 2 métodos novos: `getRelatorioPeriodicoConfig()` e `salvarRelatorioPeriodicoConfig(...)` — mesmo padrão de `getLimitConfig`/`salvarCredenciaisIntegracao`, lendo/gravando a nova chave `RELATORIO_PERIODICO_WEBHOOK` na tabela `integration_configs` já existente. |
| `apps/api/src/admin/routes.ts` | 2 rotas novas: `GET /admin/integrations/relatorio-periodico` e `POST /admin/integrations/relatorio-periodico`, mesmo padrão das rotas de credenciais. |
| `apps/workers/src/index.ts` | Importa `AdminRepository` e `inicioDoDiaEmBrasilia`; 2 funções novas de resolução de config (`resolverConfigRelatorioPeriodico`, `resolverIntervaloRelatorioPeriodicoMs`, mesmo padrão de `resolverCredenciaisLemit`/`resolverIntervaloMs`); registra o novo `loop("worker7-relatorio-periodico", ...)`. |
| `apps/admin-panel/src/app/integracoes/page.tsx` | Nova seção "Relatório periódico": toggle ativo/inativo + formulário com URL do endpoint e frequência em horas. |
| `apps/admin-panel/src/app/integracoes/actions.ts` | 2 server actions novas: `toggleRelatorioPeriodico` e `salvarRelatorioPeriodico`. |

## Arquivos novos (4)

| Caminho | O que é |
|---|---|
| `packages/domain/src/fuso-horario.ts` | Helper `inicioDoDiaEmBrasilia(agora?)` — meia-noite de Brasília em UTC, robusto ao fuso do servidor. |
| `packages/domain/src/fuso-horario.test.ts` | Testes do helper acima (3 casos, incluindo virada de dia). |
| `apps/workers/src/workers/worker7-relatorio-periodico.ts` | O worker novo — função pura (recebe `ativo`, `endpointUrl` e os KPIs já prontos; monta o corpo e faz o POST). |
| `apps/workers/src/workers/worker7-relatorio-periodico.test.ts` | Testes do worker (7 casos: desativado, sem endpoint, POST correto, cálculo da taxa de resposta incluindo divisão por zero, erro HTTP, exceção de rede). |

## Validação

- `packages/domain`: `npx vitest run` — **36 testes passando** (6 arquivos,
  incluindo os 3 novos do `fuso-horario`). Esse pacote não depende do Prisma,
  então rodou 100% sem restrição nenhuma.
- `apps/workers`: `npx vitest run src/workers/worker7-relatorio-periodico.test.ts`
  — **7 testes passando**. O worker novo não importa Prisma diretamente (só
  recebe os dados já prontos), então também rodou sem restrição.
- `apps/admin-panel`: `npx tsc --noEmit` (zero erros) e `npx next build`
  (sucesso, as mesmas 24 rotas de antes, `/integracoes` incluída).
- `packages/database`, `apps/api`, `apps/workers/src/index.ts`: como nos zips
  anteriores, o `prisma generate` não funciona neste ambiente de geração
  (`binaries.prisma.sh` bloqueado), então o `tsc` desses três não compila
  100% aqui. Validei da mesma forma que nos zips anteriores: rodei o `tsc`
  mesmo assim e conferi que os erros nos arquivos alterados são exatamente a
  MESMA categoria (módulo `@plataforma-ofertas/*` não encontrado, porque os
  pacotes do workspace não foram buildados neste ambiente) que já aparece em
  código antigo, intocado, que já funciona em produção — ou seja, nenhum erro
  NOVO ou de tipo diferente apareceu por causa do código adicionado. Isso deve
  compilar limpo no seu ambiente normal (CI/local), onde o Prisma consegue
  baixar o engine.
- **Nenhuma migração de banco necessária** — a nova integração usa só a tabela
  `integration_configs`, que já existe e já guarda a Lemit/WhatsApp/Limit do
  mesmo jeito.

## Como configurar depois de subir

1. Suba estes 6 arquivos alterados + 4 arquivos novos no GitHub, nos mesmos
   caminhos.
2. Depois do deploy, abra o painel → **Integrações** → seção **Relatório
   periódico** (no final da página).
3. Cole a URL do seu endpoint, defina a frequência em horas (ex.: `4`) e clique
   em **Salvar**.
4. Clique em **Ativar**.
5. Pronto — a partir do próximo ciclo do worker (poucos segundos depois de
   ativar), o relatório do dia passa a ser enviado automaticamente na
   frequência escolhida, todo dia.
