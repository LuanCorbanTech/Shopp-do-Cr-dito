# Ajustes na tela de Tarefas: chave na aba certa + modal

## O que mudou

1. **Chave de API da Odysseia movida pra Integrações** — antes ficava
   dentro da tela de Tarefas, agora fica junto das outras credenciais
   (Lemit, WhatsApp, Ararahq), no final da página de Integrações. A tela de
   Tarefas só usa essa chave (não mostra mais o campo pra editá-la) — tem
   um link direto pra "Integrações" no texto de ajuda, caso precise
   configurar.

2. **"Criar tarefa" agora abre um modal** — em vez do formulário abrir
   embutido na própria página (empurrando a lista pra baixo), agora abre
   como uma janela sobreposta, centralizada, com fundo escurecido — mesmo
   padrão visual já usado no modal de detalhes de Webhook.

## Nota técnica pro deploy

O endpoint da chave da Odysseia mudou de rota (só isso — nenhum dado
muda de lugar, é só o caminho da API):
- Antes: `/admin/tarefas/odysseia-config`
- Agora: `/admin/integrations/odysseia`

Isso é só interno (o painel já chama a rota certa) — não precisa de nenhum
ajuste manual, só estou documentando a mudança.

## Validação

- Build completo do admin-panel (`next build`), com checagem de tipos,
  limpo (achei e corrigi um erro de sintaxe que introduzi durante a edição
  — uma linha da declaração de outra função tinha sido apagada sem
  querer; o build pegou isso na hora).
- **89 + 69 testes** (workers + api), todos continuam passando — essa
  mudança foi só de interface, não mexeu em nenhuma lógica de backend além
  do caminho da rota.
- Testado visualmente com Playwright: modal abrindo corretamente sobre a
  lista, e a seção "Odysseia" aparecendo certinho no final da página de
  Integrações, com a chave mascarada.

## Arquivos alterados

- `packages/database/src/repositories/admin-repository.ts` (só comentário)
- `apps/api/src/admin/routes.ts` (rota renomeada)
- `apps/admin-panel/src/app/integracoes/page.tsx` (seção nova)
- `apps/admin-panel/src/app/integracoes/actions.ts` (action nova)
- `apps/admin-panel/src/app/tarefas/page.tsx` (não busca mais a config)
- `apps/admin-panel/src/app/tarefas/TarefasClient.tsx` (modal + sem card da Odysseia)
- `apps/admin-panel/src/app/tarefas/actions.ts` (action removida)

Nenhuma migração de banco nessa entrega (é a mesma tabela `tarefas` já
criada antes).
