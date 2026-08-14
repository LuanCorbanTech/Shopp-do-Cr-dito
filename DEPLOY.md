# Deploy no Droplet (DigitalOcean) com deploy automático via GitHub Actions

Guia passo a passo para conectar o repositório no GitHub ao droplet, com
deploy automático a cada push. Sem domínio por enquanto — acesso direto pelo
IP do droplet (sem HTTPS; ver observação no final sobre isso).

Arquivos relevantes que já estão no repositório para isso:
- `infra/docker/Dockerfile.api`, `Dockerfile.workers`, `Dockerfile.admin-panel`
- `docker-compose.prod.yml` (produção — diferente do `docker-compose.yml` usado em dev local)
- `.env.production.example` (modelo do `.env` real do droplet)
- `.github/workflows/deploy.yml` (a Action que faz o deploy)

---

## 0. Pré-requisito obrigatório: gerar a migration inicial do Prisma

**Isso ainda não foi feito** — no ambiente onde este código foi escrito, o
download do engine do Prisma (`binaries.prisma.sh`) é bloqueado pela rede, então
nunca rodou `prisma migrate dev` de verdade. Resultado: a pasta
`packages/database/prisma/migrations/` não existe ainda no repositório. Sem
ela, o comando `prisma migrate deploy` (usado no deploy) roda sem erro mas
**não cria nenhuma tabela** — o app subiria "funcionando" contra um banco
vazio.

Faça isso uma vez, na sua máquina local (não no droplet, não é necessário lá
ainda) — sua máquina tem internet normal, sem o bloqueio que existe neste
ambiente de sandbox:

```bash
git clone git@github.com:SEU_USUARIO/SEU_REPOSITORIO.git
cd SEU_REPOSITORIO
cp .env.example .env
npm install
docker compose up -d postgres redis   # usa o docker-compose.yml de dev, na raiz
npm run prisma:migrate -- --name init
```

Isso cria `packages/database/prisma/migrations/<timestamp>_init/migration.sql`
com o schema completo. Confira que a pasta foi criada, depois:

```bash
git add packages/database/prisma/migrations
git commit -m "Migration inicial do Prisma"
git push
```

Só depois desse push é que o `prisma migrate deploy` no droplet (passo 5)
vai ter algo para aplicar. Pode derrubar o Postgres/Redis locais depois
(`docker compose down`).

---

## 1. Preparar o droplet (Ubuntu limpo)

Pegue o IP do droplet no painel da DigitalOcean e conecte via SSH (o usuário
inicial normalmente é `root`):

```bash
ssh root@SEU_IP_DO_DROPLET
```

Atualize o sistema e crie um usuário não-root para operar o projeto:

```bash
apt update && apt upgrade -y
adduser deploy          # escolha uma senha; pode deixar os outros campos em branco
usermod -aG sudo deploy
```

Copie sua chave SSH atual (a que você já usa para acessar o droplet) para o
novo usuário, para não perder acesso:

```bash
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Configure o firewall (UFW) — **libere o SSH antes de ativar**, senão você se
tranca fora do droplet:

```bash
ufw allow OpenSSH
ufw allow 3000/tcp   # API
ufw allow 3001/tcp   # Painel administrativo
ufw enable
```

> Se você também configurou um Firewall na própria DigitalOcean (produto
> "Cloud Firewall", separado do UFW do sistema), libere as mesmas portas lá
> (22, 3000, 3001) — os dois firewalls precisam concordar.

Instale o Docker (script oficial cobre Docker Engine + Compose plugin):

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

A partir daqui, troque para o usuário `deploy` e faça tudo com ele (nunca como
root):

```bash
su - deploy
docker --version && docker compose version   # confirma que instalou certo
```

---

## 2. Dar ao droplet acesso de leitura ao repositório (Deploy Key)

Isso permite que o droplet rode `git pull` sem usar sua senha/token pessoal.

No droplet, como usuário `deploy`:

```bash
ssh-keygen -t ed25519 -C "droplet-plataforma-ofertas" -f ~/.ssh/id_ed25519_repo -N ""
cat ~/.ssh/id_ed25519_repo.pub
```

Copie a saída do `cat` (a chave pública). No GitHub: abra o repositório →
**Settings → Deploy keys → Add deploy key** → cole a chave → **não** marque
"Allow write access" (só precisa ler) → Add key.

Configure o SSH do droplet para usar essa chave ao falar com o GitHub:

```bash
cat >> ~/.ssh/config << 'EOF'
Host github.com
  IdentityFile ~/.ssh/id_ed25519_repo
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T git@github.com   # deve responder "successfully authenticated", é esperado não abrir shell
```

---

## 3. Clonar o repositório no droplet

```bash
sudo mkdir -p /opt/plataforma-ofertas
sudo chown deploy:deploy /opt/plataforma-ofertas
git clone git@github.com:SEU_USUARIO/SEU_REPOSITORIO.git /opt/plataforma-ofertas
cd /opt/plataforma-ofertas
```

(Troque `SEU_USUARIO/SEU_REPOSITORIO` pelo caminho real do seu repo no GitHub.)

---

## 4. Criar o `.env` real (nunca vai para o GitHub)

```bash
cp .env.production.example .env
nano .env   # ou vim/vi
```

Preencha pelo menos:
- `POSTGRES_PASSWORD` e o `DATABASE_URL` correspondente (troque a senha nos dois lugares).
- `ADMIN_API_TOKEN` — gere um valor forte: `openssl rand -hex 32`.
- Credenciais reais do Limit/WhatsApp/endpoints de disparo, se já as tiver
  (pode deixar em branco por agora e preencher depois — só não vai conseguir
  usar essas integrações até preencher).

---

## 5. Primeiro deploy manual (antes de automatizar)

Faça um deploy manual uma vez, para validar que tudo sobe antes de conectar o
GitHub Actions:

```bash
cd /opt/plataforma-ofertas
docker compose -f docker-compose.prod.yml --env-file .env build
docker compose -f docker-compose.prod.yml --env-file .env run --rm api npm run prisma:migrate:deploy
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

Confira se subiu:

```bash
docker compose -f docker-compose.prod.yml ps
curl http://localhost:3000/health
```

No navegador (da sua máquina, não do droplet): `http://SEU_IP_DO_DROPLET:3001`
deve abrir o painel administrativo.

(Opcional) crie o webhook de teste:

```bash
docker compose -f docker-compose.prod.yml --env-file .env run --rm api npm run prisma:seed
```

---

## 6. Automatizar: GitHub Actions faz o deploy a cada push

Isso usa um **segundo** par de chaves SSH — diferente do que você criou no
passo 2 — dedicado para o GitHub Actions entrar no droplet e rodar comandos.

### 6.1 Gerar o par de chaves (na sua máquina local, não no droplet)

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ./gh_actions_deploy -N ""
```

Isso cria dois arquivos: `gh_actions_deploy` (privada) e `gh_actions_deploy.pub`
(pública).

### 6.2 Autorizar a chave pública no droplet

Copie o **conteúdo** de `gh_actions_deploy.pub` e, no droplet (como usuário
`deploy`):

```bash
echo "COLE_A_CHAVE_PUBLICA_AQUI" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 6.3 Cadastrar os secrets no GitHub

No repositório: **Settings → Secrets and variables → Actions → New repository
secret**. Crie 4 secrets:

| Nome | Valor |
|---|---|
| `DROPLET_HOST` | IP do droplet |
| `DROPLET_USER` | `deploy` |
| `DROPLET_SSH_KEY` | conteúdo **completo** do arquivo `gh_actions_deploy` (a privada, incluindo as linhas `-----BEGIN...` e `-----END...`) |
| `DROPLET_SSH_PORT` | `22` |

Depois de colar o conteúdo do `DROPLET_SSH_KEY`, **apague o arquivo
`gh_actions_deploy` da sua máquina local** (ou guarde em um cofre de senhas) —
ele não precisa mais ficar em disco.

### 6.4 Confirmar o nome da branch padrão

O workflow (`.github/workflows/deploy.yml`) já está configurado para disparar
em push tanto para `main` quanto para `master`, então funciona com qualquer
uma das duas sem precisar editar nada.

### 6.5 Testar

Dê um push qualquer (ou uma alteração pequena) para a branch principal e
acompanhe em **Actions**, na aba do repositório no GitHub. Se dar erro de
permissão SSH, o mais comum é: chave errada no secret, usuário errado, ou
porta bloqueada pelo firewall/Cloud Firewall da DigitalOcean (libere a 22
para o IP dos runners do GitHub — na prática, para não gerenciar faixas de IP
que mudam, deixe a 22 liberada para "todos" no firewall, e confie na
autenticação por chave SSH para a segurança).

---

## Sobre não ter domínio ainda

Sem domínio, tudo funciona por HTTP simples no IP do droplet — sem
certificado TLS. Isso é aceitável para validar o sistema, mas **não é
recomendado deixar assim com dados reais de clientes/CPF trafegando sem
HTTPS**. Quando tiver um domínio, os passos futuros são: apontar um registro
A do domínio para o IP do droplet, instalar Nginx como proxy reverso na porta
80/443, e usar `certbot` (Let's Encrypt) para gerar o certificado — nesse
momento pode fechar as portas 3000/3001 no firewall e só deixar 80/443
abertas, com o Nginx roteando internamente.
