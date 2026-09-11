# PACOTE FINAL E COMPLETO — módulo Qualidade WhatsApp

**Este pacote substitui os dois anteriores.** É a versão completa e atual
de todos os arquivos do módulo — inclui tudo que já foi corrigido (dashboard,
placeholder, cadastro de BM com WABAs junto) e os 3 arquivos que ficaram de
fora no seu upload anterior e quebraram o build (`ExcluirBmButton.tsx`,
`ExcluirWabaButton.tsx`, `TestarWabaButton.tsx`).

## O que causou o erro do último deploy

O log mostrou:
```
Module not found: Can't resolve './ExcluirBmButton'
Module not found: Can't resolve './ExcluirWabaButton'
Module not found: Can't resolve './TestarWabaButton'
```
Esses 3 arquivos fazem parte do módulo desde o início, mas não chegaram a
entrar no seu repositório (provavelmente ficaram de fora num dos uploads
manuais anteriores). Sem eles, a tela de Qualidade WhatsApp não compila.

**Boa notícia**: como o script de deploy usa `set -e`, ele parou bem aí — a
migração de banco **não rodou** e o `docker compose up -d` **não rodou**.
Nada de novo foi colocado no ar; seu site continua funcionando na versão
anterior, sem nenhum risco pros dados.

Testei isso de verdade: recriei uma cópia do repositório sem nenhum arquivo
do módulo, apliquei só os arquivos deste pacote por cima, e rodei o build
completo do zero — compilou limpo, com as duas rotas (`/qualidade-whatsapp`
e `/qualidade-whatsapp/numeros/[id]`) geradas normalmente.

## Recomendação forte pra esse upload: use o GitHub Desktop

Já foram dois problemas causados por upload parcial/no lugar errado pelo
site do GitHub (a dashboard sumida, e agora esses 3 arquivos que não
chegaram a subir). São 24 arquivos no total — o GitHub Desktop resolve isso
de um jeito bem mais seguro: você copia esta pasta `qualidade-whatsapp`
inteira (mantendo a estrutura de subpastas) por cima da pasta do
repositório clonado no seu computador, o programa mostra a lista de tudo
que mudou, e você confirma um commit único com tudo — não tem como um
arquivo ficar pra trás ou ir pro lugar errado, porque a pasta já está
organizada certa antes de qualquer coisa subir.

Se preferir continuar pelo site do GitHub, dá certo também — só confira,
arquivo por arquivo, que o caminho de pasta bate exatamente com a lista
abaixo antes de confirmar cada commit.

## Lista completa (24 arquivos) — mesma ordem de upload de sempre

### 1º — Schema + Migração
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20260910120000_qualidade_whatsapp_bms/migration.sql`

### 2º — Domain
- `packages/domain/src/qualidade-whatsapp.ts`
- `packages/domain/src/qualidade-whatsapp.test.ts`
- `packages/domain/src/index.ts`

### 3º — Database
- `packages/database/src/repositories/admin-repository.ts`

### 4º — Workers
- `apps/workers/src/fornecedores/meta-qualidade-whatsapp.ts`
- `apps/workers/src/fornecedores/meta-qualidade-whatsapp.test.ts`
- `apps/workers/src/workers/worker10-qualidade-whatsapp.ts`
- `apps/workers/src/workers/worker10-qualidade-whatsapp.test.ts`
- `apps/workers/src/index.ts`

### 5º — API
- `apps/api/src/admin/routes.ts`

### 6º — Painel administrativo
- `apps/admin-panel/src/app/AppShell.tsx`
- `apps/admin-panel/src/app/globals.css`
- `apps/admin-panel/src/app/page.tsx` *(o Dashboard — confirme que continua
  igual a este se você já tinha corrigido antes; não custa subir de novo)*
- `apps/admin-panel/src/app/qualidade-whatsapp/actions.ts`
- `apps/admin-panel/src/app/qualidade-whatsapp/page.tsx`
- `apps/admin-panel/src/app/qualidade-whatsapp/NovaBmForm.tsx`
- `apps/admin-panel/src/app/qualidade-whatsapp/ExcluirBmButton.tsx` ⚠️ que
  faltou da última vez
- `apps/admin-panel/src/app/qualidade-whatsapp/ExcluirWabaButton.tsx` ⚠️ que
  faltou da última vez
- `apps/admin-panel/src/app/qualidade-whatsapp/TestarWabaButton.tsx` ⚠️ que
  faltou da última vez
- `apps/admin-panel/src/app/qualidade-whatsapp/numeros/[id]/page.tsx`
- `apps/admin-panel/src/app/qualidade-whatsapp/numeros/[id]/QualidadeHistoricoChart.tsx`
- `apps/admin-panel/src/app/api/qualidade-whatsapp-testar-waba/route.ts`

**Atenção especial à pasta `numeros/[id]/`** — o nome da pasta tem colchetes
mesmo, é a convenção do Next.js pra rota dinâmica.

## Depois de subir

O push já dispara o deploy automático. Se quiser conferir, acompanhe a aba
"Actions" do repositório no GitHub — dessa vez, com os 3 arquivos presentes,
o build deve passar e a migração (as 4 tabelas novas) deve ser aplicada
nesse mesmo deploy.

## Resumo do que esse módulo faz (caso precise relembrar)

Monitora a qualidade dos números de WhatsApp de cada BM, consultando a Meta
periodicamente (token por BM, `waba_id` por WABA), com histórico completo,
alerta por webhook quando um número piora, e uma tela própria pra cadastrar
BMs/WABAs (agora aceitando colar várias WABAs de uma vez no cadastro da BM).
Nenhuma tabela existente foi alterada — só 4 tabelas novas.
