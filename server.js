#!/usr/bin/env node
/**
 * server.js
 *
 * Servidor para a ferramenta "Formatador de Base para Disparo".
 * - Serve o HTML e faz proxy das chamadas à API da CheckNumber.AI (evita CORS)
 * - Login individual por pessoa, com sessão via cookie
 * - Bloqueio temporário após várias tentativas de login erradas
 * - Fluxo de "esqueci minha senha"
 * - Painel administrativo: usuários, papéis, créditos, times (crédito compartilhado)
 * - Log de ações administrativas
 * - Histórico de bases processadas
 * - Agendamento: formatação + validação de WhatsApp automática no horário marcado
 *
 * PERSISTÊNCIA: tudo (usuários, times, histórico, configurações, agendamentos,
 * arquivos das bases agendadas) fica salvo num banco de dados Postgres —
 * sobrevive a qualquer deploy novo, diferente da versão anterior que usava
 * arquivos locais (que se perdiam a cada deploy na DigitalOcean App Platform).
 *
 * CONFIGURAÇÃO OBRIGATÓRIA:
 *   Defina a variável de ambiente DATABASE_URL com a string de conexão do
 *   Postgres (a DigitalOcean fornece isso automaticamente ao anexar um banco
 *   "Dev Database" ao seu app e vincular ao componente).
 *
 * PRIMEIRO ACESSO (bootstrap do administrador):
 *   Configure ADMIN_USER e ADMIN_PASS na primeira vez que subir o app. Só
 *   são usadas para CRIAR o primeiro administrador (se a tabela de usuários
 *   estiver vazia). Depois disso pode remover essas variáveis.
 *
 * USO LOCAL:
 *   npm install
 *   DATABASE_URL=postgres://user:pass@localhost:5432/meubanco node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const { Pool } = require('pg');
// Geração do PDF da fatura do módulo financeiro (times pós-pagos) — pura
// JavaScript, sem dependência nativa, funciona igual em qualquer ambiente.
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
// Regras de negócio Wati/Hyperflow — mesmo arquivo usado pelo navegador (Formatador
// de base) e pelo servidor (Agendamentos), para as duas rodarem sempre a mesma lógica.
const WatiHyperflowRules = require('./js/wati-hyperflow-rules.js');

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'formatador_base_disparo.html');
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
const LOGIN_FILE = path.join(__dirname, 'login.html');
const ADMIN_FILE = path.join(__dirname, 'admin.html');
const HISTORICO_FILE = path.join(__dirname, 'historico.html');
const AGENDA_FILE = path.join(__dirname, 'agendamentos.html');
const AJUDA_FILE = path.join(__dirname, 'ajuda.html');
const LINKS_FILE = path.join(__dirname, 'links.html');
const CONSUMO_FILE = path.join(__dirname, 'consumo.html');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos

// ---------- Conexão com o banco ----------
if (!process.env.DATABASE_URL) {
  console.error('\n[AVISO] A variável DATABASE_URL não está configurada. O sistema não vai conseguir salvar nada (usuários, histórico, etc). Configure a conexão do Postgres antes de usar em produção.\n');
}

function buildPoolConfig() {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) return { connectionString: raw, ssl: false };

  const isLocal = /localhost|127\.0\.0\.1/.test(raw);

  // Importante: se a connection string tiver "sslmode=require" (padrão em bancos
  // gerenciados), o driver pg reprocessa a própria string e SOBRESCREVE a opção
  // ssl que passamos abaixo, ativando verificação estrita de certificado (o que
  // causa o erro "self-signed certificate in certificate chain" em bancos de
  // desenvolvimento da DigitalOcean). Por isso removemos esses parâmetros da URL
  // e controlamos o SSL só pela opção explícita.
  let cleaned = raw;
  try {
    const u = new URL(raw);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('ssl');
    cleaned = u.toString();
  } catch (e) { /* se não for uma URL válida, segue com a original */ }

  return {
    connectionString: cleaned,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  };
}

const pool = new Pool(buildPoolConfig());

async function q(text, params) {
  return pool.query(text, params);
}

async function initSchema() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    credits INTEGER,
    team_id TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS link_credits INTEGER`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
  // logo do cliente/parceiro, exibida ao lado do nome — guardada como bytes
  // dentro do próprio Postgres (não em arquivo local), pelo mesmo motivo dos
  // outros uploads do sistema (upload_data/result_data dos agendamentos):
  // a DigitalOcean App Platform reseta o disco local a cada deploy, então
  // qualquer coisa salva só em arquivo se perderia na próxima atualização.
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS logo_data BYTEA`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS logo_mime TEXT`);
  await q(`CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    credits INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS link_credits INTEGER`);
  // ---- Módulo financeiro: cobrança pré-paga (como já era) ou pós-paga
  // (uso sem limite, fechado em ciclos e cobrado por relatório) ----
  // billing_type: 'prepago' (padrão, comportamento de sempre) ou 'pospago'.
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS billing_type TEXT NOT NULL DEFAULT 'prepago'`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS price_per_credit_base NUMERIC`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS price_per_credit_link NUMERIC`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS billing_cycle_days INTEGER`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS cycle_start TIMESTAMPTZ`);
  // ---- API de validação de WhatsApp (consulta avulsa, número a número) ----
  // Só times pós-pagos podem ter credencial (pedido explícito). Guardamos só
  // o HASH da chave (sha256) — igual senha, nunca em texto puro no banco — e
  // um prefixo curto só pra exibir no Admin ("cbk_live_a1b2c3...") sem expor
  // a chave inteira de novo depois que ela já foi mostrada uma vez.
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS api_key_hash TEXT`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS api_key_prefix TEXT`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMPTZ`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS teams_api_key_hash_idx ON teams (api_key_hash) WHERE api_key_hash IS NOT NULL`);
  // Webhook padrão pra receber o resultado das consultas via API — pode ser
  // sobrescrito por chamada (campo callback_url no corpo da requisição).
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS webhook_url TEXT`);
  // Dados do cliente/time usados no cabeçalho da fatura em PDF — opcionais,
  // valem tanto para time pré-pago quanto pós-pago (só quem é pós-pago gera
  // fatura de verdade, mas o cadastro fica disponível pros dois).
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS cnpj TEXT`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS responsavel_nome TEXT`);
  await q(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS responsavel_email TEXT`);
  // Livro-razão de uso: só é preenchido para times pós-pagos (é a fonte dos
  // relatórios). Grava o preço por crédito NO MOMENTO do uso — se o preço do
  // time mudar depois, os relatórios já fechados continuam corretos.
  // file_name: nome do arquivo processado (quando disponível) — usado pra
  // detalhar a fatura em PDF linha a linha, um arquivo por linha (só faz
  // sentido pra credit_type='base'; crédito de link não tem "arquivo").
  await q(`CREATE TABLE IF NOT EXISTS credit_usage_log (
    id SERIAL PRIMARY KEY,
    team_id TEXT NOT NULL,
    credit_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price NUMERIC,
    amount NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`ALTER TABLE credit_usage_log ADD COLUMN IF NOT EXISTS file_name TEXT`);
  // origem do consumo — 'sistema' (formatador de base, comportamento de sempre)
  // ou 'api' (consulta avulsa via API de validação de WhatsApp). Desconta do
  // MESMO saldo/preço de sempre (por pedido explícito), só serve pra separar
  // a exibição no relatório financeiro/fatura.
  await q(`ALTER TABLE credit_usage_log ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'sistema'`);
  await q(`CREATE INDEX IF NOT EXISTS credit_usage_log_team_idx ON credit_usage_log (team_id, created_at)`);
  // Faturas: uma por ciclo fechado de um time pós-pago. Guarda o nome do
  // time e os preços aplicados NAQUELE momento (snapshot), pra continuar
  // fazendo sentido mesmo se o time for renomeado/excluído ou o preço mudar
  // depois. O PDF já gerado fica salvo em bytes (mesmo motivo da logo:
  // disco local não sobrevive a um novo deploy na DigitalOcean).
  await q(`CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    team_id TEXT NOT NULL,
    team_name TEXT,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    credits_base_used INTEGER NOT NULL DEFAULT 0,
    credits_link_used INTEGER NOT NULL DEFAULT 0,
    price_per_credit_base NUMERIC,
    price_per_credit_link NUMERIC,
    amount_base NUMERIC NOT NULL DEFAULT 0,
    amount_link NUMERIC NOT NULL DEFAULT 0,
    amount_total NUMERIC NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pendente',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at TIMESTAMPTZ,
    pdf_data BYTEA
  )`);
  await q(`CREATE INDEX IF NOT EXISTS invoices_team_idx ON invoices (team_id, generated_at)`);
  await q(`CREATE TABLE IF NOT EXISTS history (
    id SERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    username TEXT,
    name TEXT,
    filename TEXT,
    platform TEXT,
    scheduled BOOLEAN NOT NULL DEFAULT false,
    total INTEGER DEFAULT 0,
    valid INTEGER DEFAULT 0,
    invalid INTEGER DEFAULT 0,
    duplicates INTEGER DEFAULT 0,
    no_whatsapp INTEGER DEFAULT 0
  )`);
  await q(`ALTER TABLE history ADD COLUMN IF NOT EXISTS cliente TEXT`);
  // team_id é a referência confiável (igual credit_usage_log já usa) — o
  // campo "cliente" acima é só um texto solto pra exibição, então dois
  // lugares diferentes podiam divergir sobre "qual time" uma execução
  // pertencia. Com team_id, Histórico e Financeiro passam a contar
  // exatamente a mesma coisa, sempre.
  await q(`ALTER TABLE history ADD COLUMN IF NOT EXISTS team_id TEXT`);
  // Detalhes da execução (pedido explícito: divisão de HSM, fragmentação do
  // arquivo, consumo de créditos exato, se validou WhatsApp) — ver botão
  // "Visualizar detalhes" no Histórico.
  await q(`ALTER TABLE history ADD COLUMN IF NOT EXISTS hsm_count INTEGER`);
  await q(`ALTER TABLE history ADD COLUMN IF NOT EXISTS file_parts INTEGER`);
  await q(`ALTER TABLE history ADD COLUMN IF NOT EXISTS credits_consumed BOOLEAN`);
  await q(`ALTER TABLE history ADD COLUMN IF NOT EXISTS credits_amount NUMERIC`);
  await q(`ALTER TABLE history ADD COLUMN IF NOT EXISTS whatsapp_validated BOOLEAN`);

  // Preenche retroativamente o team_id de registros antigos (gravados antes
  // dessa correção, quando esse vínculo não existia) — cruza pelo usuário
  // que fez o upload, já que esse dado sempre existiu de forma confiável.
  // Idempotente: só mexe em quem ainda está com team_id em branco.
  await q(`
    UPDATE history h SET team_id = u.team_id
    FROM users u
    WHERE h.team_id IS NULL AND h.username = u.username AND u.team_id IS NOT NULL
  `).catch((e) => console.error('[migração] falha ao preencher team_id retroativo no histórico:', e.message));
  await q(`CREATE TABLE IF NOT EXISTS admin_log (
    id SERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor TEXT,
    action TEXT,
    target TEXT,
    details TEXT
  )`);
  await q(`CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    username TEXT,
    name TEXT,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT
  )`);
  await q(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  // Dados de quem emite a fatura (cabeçalho/PIX/rodapé do PDF financeiro) —
  // semeados uma única vez com os dados reais da CorbanTech (pra já sair
  // funcionando), mas seguem editáveis a qualquer momento em
  // Admin → Configurações → "Dados da fatura (emissor)".
  await q(`INSERT INTO settings (key, value) VALUES
      ('companyName', 'CorbanTech LTDA'),
      ('companyCnpj', '17.718.302/0001-00'),
      ('companyEmail', 'contato@corbantech.digital'),
      ('companyPhone', '(62) 99371-8537'),
      ('companyPixKey', '17.718.302/0001-00'),
      ('companyPixBanco', 'Banco Inter'),
      ('companySite', 'corbantech.digital')
    ON CONFLICT (key) DO NOTHING`);
  // Jobs de validação de WhatsApp "ao vivo" (Formatador de base, sob demanda,
  // fora do fluxo de Agendamentos) — ver comentário completo perto de
  // createLiveWaJob/getLiveWaJob mais abaixo.
  await q(`CREATE TABLE IF NOT EXISTS live_wa_jobs (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    provider_task_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    result_url TEXT,
    total INTEGER DEFAULT 0,
    success INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Consultas avulsas feitas pela API pública (POST /api/v1/whatsapp/check).
  // Processado em segundo plano — a resposta da API é sempre imediata (a
  // DigitalOcean App Platform derruba com 502 qualquer requisição que demore
  // demais, e o fornecedor da validação não é instantâneo nem para 1 número).
  // O resultado final é entregue por webhook (se o time tiver configurado) e
  // sempre pode ser consultado depois por GET, como plano B.
  await q(`CREATE TABLE IF NOT EXISTS api_wa_checks (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    has_whatsapp BOOLEAN,
    error_message TEXT,
    callback_url TEXT,
    callback_delivered BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  )`);
  await q(`CREATE INDEX IF NOT EXISTS api_wa_checks_team_idx ON api_wa_checks (team_id, created_at)`);

  // Consulta em LOTE (ver docs/api-validacao-whatsapp-lote — endpoint novo
  // POST /api/v1/whatsapp/check-lote), usada pra parceiros com volume alto
  // que topam esperar um pouco em troca de custo bem menor por número
  // (reaproveita a mesma integração com o fornecedor de lote que já existe
  // pro Formatador de base — ver createWaValidationTask/pollWaValidationTask).
  await q(`CREATE TABLE IF NOT EXISTS api_wa_lotes (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    total INTEGER NOT NULL,
    resultados JSONB,
    error_message TEXT,
    callback_url TEXT,
    callback_delivered BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  )`);
  await q(`CREATE INDEX IF NOT EXISTS api_wa_lotes_team_idx ON api_wa_lotes (team_id, created_at)`);
  // Migração única: a chave de configuração do validador de WhatsApp mudou
  // de nome (não é mais "checknumberApiKey") por questão de whitelabel —
  // o nome do fornecedor não deve aparecer em nenhum lugar acessível pelo
  // cliente. Se já existir um valor salvo com o nome antigo, copia pro nome
  // novo automaticamente (sem exigir reconfiguração manual) e remove o antigo.
  await q(`INSERT INTO settings (key, value) SELECT 'waApiKey', value FROM settings WHERE key = 'checknumberApiKey' ON CONFLICT (key) DO NOTHING`);
  await q(`DELETE FROM settings WHERE key = 'checknumberApiKey'`);
  await q(`CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    username TEXT,
    name TEXT,
    filename TEXT,
    upload_data BYTEA,
    upload_ext TEXT,
    platform TEXT,
    ddi_padrao TEXT,
    hsm_groups INTEGER,
    split_parts INTEGER,
    variables JSONB,
    scheduled_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'agendado',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error TEXT,
    result_data BYTEA,
    result_filename TEXT,
    content_type TEXT,
    stats JSONB
  )`);
  await q(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS cliente TEXT`);
  await q(`CREATE TABLE IF NOT EXISTS short_links (
    id TEXT PRIMARY KEY,
    username TEXT,
    owner_name TEXT,
    shortio_link_id TEXT,
    original_url TEXT,
    short_url TEXT,
    path TEXT,
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS suggestions (
    id SERIAL PRIMARY KEY,
    username TEXT,
    name TEXT,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved BOOLEAN NOT NULL DEFAULT false,
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT
  )`);
}

// ---------- Senha: hash com salt (scrypt, nativo do Node) ----------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(plain, salt, 64).toString('hex');
  const bufA = Buffer.from(hash, 'hex');
  const bufB = Buffer.from(check, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function randomTempPassword() {
  const part = () => crypto.randomBytes(3).toString('hex');
  return `${part()}-${part()}`;
}

// ---------- Usuários ----------
function rowToUser(r) {
  if (!r) return null;
  return {
    username: r.username,
    passwordHash: r.password_hash,
    name: r.name,
    email: r.email,
    role: r.role,
    credits: r.credits,
    linkCredits: r.link_credits,
    teamId: r.team_id,
    active: r.active,
    createdAt: r.created_at,
    // aponta pra rota que serve os bytes da logo (guardados no Postgres) —
    // nunca mandamos o BYTEA em si no JSON, só esse caminho curto.
    // `has_logo` vem de queries otimizadas (sem carregar o BYTEA inteiro
    // pra listar usuários); `logo_data` vem de SELECT * (usuário único).
    logoUrl: (r.has_logo !== undefined ? !!r.has_logo : !!r.logo_data)
      ? ('/api/user-logo/' + encodeURIComponent(r.username)) : null,
  };
}

// Mapa username -> {name, logoUrl}, usado para exibir a logo/avatar do
// cliente ao lado do nome em Histórico, Painel, Agendamentos e Log de ações
// — sem precisar alterar a query original de cada uma dessas telas.
async function getUserAvatarMap() {
  const { rows } = await q('SELECT username, name, (logo_data IS NOT NULL) AS has_logo FROM users');
  const map = {};
  for (const r of rows) map[r.username] = { name: r.name, logoUrl: r.has_logo ? ('/api/user-logo/' + encodeURIComponent(r.username)) : null };
  return map;
}

async function seedUsersIfNeeded() {
  const { rows } = await q('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;

  let seeded = [];
  try {
    if (process.env.USERS) {
      seeded = JSON.parse(process.env.USERS).map(u => ({ username: u.username, password: u.password, name: u.name || u.username }));
    } else if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
      seeded = [{ username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS, name: process.env.ADMIN_USER }];
    } else if (process.env.AUTH_USER && process.env.AUTH_PASS) {
      seeded = [{ username: process.env.AUTH_USER, password: process.env.AUTH_PASS, name: process.env.AUTH_USER }];
    }
  } catch (e) {
    console.error('Não consegui interpretar variáveis de usuário no boot:', e.message);
  }

  for (const u of seeded) {
    await q(
      `INSERT INTO users (username, password_hash, name, role, credits, team_id, active) VALUES ($1,$2,$3,'admin',NULL,NULL,true)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, hashPassword(u.password), u.name]
    );
  }
  if (seeded.length) {
    console.log(`Usuário(s) inicial(is) criado(s): ${seeded.map(u => u.username).join(', ')}`);
  } else {
    console.log('Nenhum usuário configurado no boot. Defina ADMIN_USER/ADMIN_PASS e reinicie.');
  }
}

async function readUsers() {
  // não seleciona logo_data (BYTEA) aqui — listar todos os usuários não
  // precisa dos bytes da imagem, só saber se cada um tem logo ou não
  // (has_logo); os bytes só são lidos sob demanda em /api/user-logo/:username
  const { rows } = await q(`SELECT username, password_hash, name, email, role, credits,
    link_credits, team_id, active, created_at, (logo_data IS NOT NULL) AS has_logo
    FROM users ORDER BY created_at ASC`);
  return rows.map(rowToUser);
}
async function findUserRecord(username) {
  const { rows } = await q('SELECT * FROM users WHERE username = $1', [username]);
  return rowToUser(rows[0]);
}
async function countActiveAdmins(excludeUsername) {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM users WHERE role='admin' AND active=true AND username <> COALESCE($1,'')`,
    [excludeUsername || null]
  );
  return rows[0].n;
}

// ---------- Times ----------
function rowToTeam(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, credits: r.credits, linkCredits: r.link_credits, createdAt: r.created_at,
    billingType: r.billing_type || 'prepago',
    pricePerCreditBase: r.price_per_credit_base === null ? null : Number(r.price_per_credit_base),
    pricePerCreditLink: r.price_per_credit_link === null ? null : Number(r.price_per_credit_link),
    billingCycleDays: r.billing_cycle_days,
    cycleStart: r.cycle_start,
    cnpj: r.cnpj || '',
    responsavelNome: r.responsavel_nome || '',
    responsavelEmail: r.responsavel_email || '',
    // API de validação avulsa — nunca expõe o hash, só o suficiente pro Admin mostrar status.
    hasApiKey: !!r.api_key_hash,
    apiKeyPrefix: r.api_key_prefix || null,
    apiKeyCreatedAt: r.api_key_created_at || null,
    webhookUrl: r.webhook_url || '',
  };
}
async function readTeams() {
  const { rows } = await q('SELECT * FROM teams ORDER BY created_at ASC');
  return rows.map(rowToTeam);
}
async function findTeam(teamId) {
  if (!teamId) return null;
  const { rows } = await q('SELECT * FROM teams WHERE id = $1', [teamId]);
  return rowToTeam(rows[0]);
}

// ---- Credencial de API (consulta avulsa de WhatsApp) — 1 chave por time ----
// Só o hash (sha256) fica salvo; a chave em texto puro só existe no momento
// em que é gerada (resposta da rota) e nunca mais pode ser recuperada — igual
// senha. Prefixo curto (8 chars) fica salvo à parte só pra exibir no Admin.
function generateApiKeyPlaintext() {
  return 'cbk_live_' + crypto.randomBytes(24).toString('hex');
}
function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex');
}
async function findTeamByApiKey(plainKey) {
  if (!plainKey) return null;
  const { rows } = await q('SELECT * FROM teams WHERE api_key_hash = $1', [hashApiKey(plainKey)]);
  return rowToTeam(rows[0]);
}

// ---------- Log de ações administrativas ----------
async function logAdminAction(actor, action, target, details) {
  await q('INSERT INTO admin_log (actor, action, target, details) VALUES ($1,$2,$3,$4)', [actor, action, target, details || '']);
}
async function readAdminLog() {
  const { rows } = await q('SELECT * FROM admin_log ORDER BY ts DESC LIMIT 1000');
  const avatarMap = await getUserAvatarMap();
  return rows.map(r => ({
    ts: r.ts, actor: r.actor, action: r.action, target: r.target, details: r.details,
    actorLogoUrl: (avatarMap[r.actor] && avatarMap[r.actor].logoUrl) || null,
  }));
}

// ---------- Solicitações de redefinição de senha ----------
async function readResets() {
  const { rows } = await q('SELECT * FROM password_resets ORDER BY ts DESC LIMIT 200');
  return rows.map(r => ({ id: r.id, username: r.username, name: r.name, ts: r.ts, status: r.status, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by }));
}

// ---------- Configurações do sistema ----------
const SETTINGS_KEYS = [
  // waApiKey = checknumber.ai, continua servindo SÓ o Formatador de base
  // (upload de planilha em massa, /proxy/tasks e agendamentos). NÃO é mais
  // usado pela consulta individual da API (ver ekycproApiKey abaixo) — o
  // checknumber.ai não tem um endpoint de consulta avulsa de verdade (exige
  // mínimo de 500 números por lote mesmo no "modo simples"), então não serve
  // pra validar 1 número por vez em tempo real.
  'waApiKey',
  // ekycproApiKey = eKYC Pro (docs.ekycpro.com), usado exclusivamente pela
  // rota /api/v1/whatsapp/check (consulta individual via API — Shopp do
  // Crédito e qualquer outro parceiro que chame a API). Endpoint síncrono de
  // verdade (POST /v1/check, resposta em ~180ms), sem mínimo de lote.
  'ekycproApiKey',
  'shortioApiKey', 'shortioDomain',
  // Dados de quem emite a fatura em PDF (módulo financeiro) — ver initSchema.
  'companyName', 'companyCnpj', 'companyEmail', 'companyPhone', 'companyPixKey', 'companyPixBanco', 'companySite',
];
async function readSettings() {
  const { rows } = await q(`SELECT key, value FROM settings WHERE key = ANY($1)`, [SETTINGS_KEYS]);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const out = {};
  for (const key of SETTINGS_KEYS) out[key] = map[key] || '';
  return out;
}
async function writeSettings(data) {
  for (const key of SETTINGS_KEYS) {
    if (data[key] !== undefined) {
      await q(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, data[key]]
      );
    }
  }
}

// ---------- Bloqueio por tentativas de login erradas (em memória — reinicia com o servidor, ok) ----------
const loginAttempts = new Map();
function isLocked(username) {
  const rec = loginAttempts.get(username);
  if (!rec || !rec.lockedUntil) return false;
  if (rec.lockedUntil > Date.now()) return true;
  loginAttempts.delete(username);
  return false;
}
function registerFailedAttempt(username) {
  const rec = loginAttempts.get(username) || { count: 0, lockedUntil: null };
  rec.count += 1;
  if (rec.count >= MAX_LOGIN_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    rec.count = 0;
  }
  loginAttempts.set(username, rec);
}
function clearAttempts(username) { loginAttempts.delete(username); }

// ---------- Limite de requisições da API de validação avulsa (em memória) ----------
// Janela fixa de 60s por time — reinicia com o servidor, igual ao bloqueio de
// login (não precisa sobreviver a um deploy, é só uma proteção contra abuso).
const API_RATE_LIMIT = 60; // requisições por minuto por time
const API_RATE_WINDOW_MS = 60 * 1000;
const apiRateLimits = new Map();
function checkApiRateLimit(teamId) {
  const now = Date.now();
  const rec = apiRateLimits.get(teamId);
  if (!rec || now >= rec.windowStart + API_RATE_WINDOW_MS) {
    apiRateLimits.set(teamId, { windowStart: now, count: 1 });
    return { ok: true };
  }
  if (rec.count >= API_RATE_LIMIT) {
    const retryAfterSec = Math.ceil((rec.windowStart + API_RATE_WINDOW_MS - now) / 1000);
    return { ok: false, retryAfterSec };
  }
  rec.count += 1;
  return { ok: true };
}

// Limite separado (mais generoso) pro GET de consulta de status — não deve
// competir com o orçamento de novas consultas (POST) do mesmo time.
const API_POLL_RATE_LIMIT = 120; // consultas de status por minuto por time
const apiPollRateLimits = new Map();
function checkApiPollRateLimit(teamId) {
  const now = Date.now();
  const rec = apiPollRateLimits.get(teamId);
  if (!rec || now >= rec.windowStart + API_RATE_WINDOW_MS) {
    apiPollRateLimits.set(teamId, { windowStart: now, count: 1 });
    return { ok: true };
  }
  if (rec.count >= API_POLL_RATE_LIMIT) {
    const retryAfterSec = Math.ceil((rec.windowStart + API_RATE_WINDOW_MS - now) / 1000);
    return { ok: false, retryAfterSec };
  }
  rec.count += 1;
  return { ok: true };
}

// ---------- Sessões em memória ----------
const sessions = new Map();
function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
async function getSessionUserRecord(req) {
  if (!LOGIN_REQUIRED) return { username: 'local', name: 'Local', role: 'admin', credits: null, teamId: null, active: true };
  const cookies = parseCookies(req);
  const token = cookies['sid'];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(token); return null; }
  const user = await findUserRecord(session.username);
  if (!user || user.active === false) { sessions.delete(token); return null; }
  return user;
}
function setCookieHeader(req, token, maxAgeSeconds) {
  const isHttps = (req.headers['x-forwarded-proto'] || '').includes('https');
  let cookie = `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  if (isHttps) cookie += '; Secure';
  return cookie;
}
function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}
async function publicUserWithTeam(u) {
  const rest = publicUser(u);
  if (rest.teamId) {
    const team = await findTeam(rest.teamId);
    if (team) {
      rest.teamName = team.name;
      rest.billingType = team.billingType; // usado só pra mostrar/esconder o link "Meu consumo" (pós-pago)
      // Time pós-pago nunca tem os créditos descontados de verdade (ver
      // deductCreditsFor/checkLinkCreditsSufficient) — o número em
      // team.credits/team.linkCredits pode ficar parado em qualquer valor
      // (às vezes 0, resto de antes de virar pós-pago), e não representa um
      // limite real. Reportar como null aqui faz a tela mostrar "ilimitado"
      // e não disparar o aviso de saldo baixo por engano — mesmo tratamento
      // que checkLinkCreditsSufficient já dava só pros créditos de link.
      if (team.billingType === 'pospago') {
        rest.credits = null;
        rest.linkCredits = null;
      } else {
        rest.credits = team.credits;
        rest.linkCredits = team.linkCredits;
      }
    }
  }
  return rest;
}

// ---------- Utilidades de arquivo/rede ----------
function sendFile(res, filePath, contentType, status) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado: ' + filePath);
      return;
    }
    res.writeHead(status || 200, { 'content-type': contentType });
    res.end(data);
  });
}
function sendBuffer(res, buffer, contentType) {
  res.writeHead(200, { 'content-type': contentType || 'application/octet-stream' });
  res.end(buffer);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function parseFormUrlEncoded(buf) {
  const out = {};
  new URLSearchParams(buf.toString('utf-8')).forEach((v, k) => { out[k] = v; });
  return out;
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- Logo do cliente/parceiro ----------
// Guardada como bytes dentro do próprio Postgres (colunas logo_data/
// logo_mime) — não em arquivo local — porque o disco da DigitalOcean App
// Platform é apagado a cada deploy novo. É o mesmo motivo pelo qual os
// arquivos dos agendamentos (upload_data/result_data) também ficam no banco.
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB
const LOGO_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml']);
// Recebe uma data URL ("data:image/png;base64,AAAA...") e devolve
// { mime, buffer } prontos para gravar nas colunas logo_mime/logo_data.
// Lança erro com mensagem amigável se o formato/tamanho não for permitido.
function decodeLogoDataUrl(logoDataUrl) {
  const match = /^data:([\w./+-]+);base64,(.+)$/.exec(logoDataUrl || '');
  if (!match) throw new Error('Formato de imagem inválido.');
  const mime = match[1].toLowerCase();
  if (!LOGO_MIME_WHITELIST.has(mime)) throw new Error('Tipo de imagem não permitido. Use PNG, JPG, WEBP ou SVG.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('Não consegui ler a imagem enviada.');
  if (buffer.length > MAX_LOGO_BYTES) throw new Error('A imagem passou de 2 MB. Escolha um arquivo menor.');
  return { mime, buffer };
}

// ---------- Histórico ----------
async function readHistory(usernameFilter) {
  const { rows } = usernameFilter
    ? await q('SELECT * FROM history WHERE username = $1 ORDER BY ts DESC LIMIT 500', [usernameFilter])
    : await q('SELECT * FROM history ORDER BY ts DESC LIMIT 500');
  const avatarMap = await getUserAvatarMap();
  return rows.map(r => ({
    id: r.id, ts: r.ts, user: r.username, name: r.name, cliente: r.cliente, teamId: r.team_id, filename: r.filename, platform: r.platform,
    scheduled: r.scheduled, total: r.total, valid: r.valid, invalid: r.invalid,
    duplicates: r.duplicates, noWhatsApp: r.no_whatsapp,
    hsmCount: r.hsm_count, fileParts: r.file_parts,
    creditsConsumed: r.credits_consumed, creditsAmount: r.credits_amount != null ? Number(r.credits_amount) : null,
    whatsappValidated: r.whatsapp_validated,
    logoUrl: (avatarMap[r.username] && avatarMap[r.username].logoUrl) || null,
  }));
}
async function appendHistory(entry) {
  const { rows } = await q(
    `INSERT INTO history (username, name, cliente, team_id, filename, platform, scheduled, total, valid, invalid, duplicates, no_whatsapp,
                          hsm_count, file_parts, credits_consumed, credits_amount, whatsapp_validated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      entry.user, entry.name, entry.cliente || '', entry.teamId || null, entry.filename, entry.platform, !!entry.scheduled,
      entry.total || 0, entry.valid || 0, entry.invalid || 0, entry.duplicates || 0, entry.noWhatsApp || 0,
      entry.hsmCount != null ? entry.hsmCount : null, entry.fileParts != null ? entry.fileParts : null,
      entry.creditsConsumed != null ? entry.creditsConsumed : null, entry.creditsAmount != null ? entry.creditsAmount : null,
      entry.whatsappValidated != null ? entry.whatsappValidated : null,
    ]
  );
  return rows[0].id;
}
// Atualiza uma execução JÁ registrada (em vez de criar uma linha nova) —
// usado quando a pessoa baixa o arquivo mais de uma vez na mesma sessão
// (ex.: baixou antes de validar o WhatsApp, e baixa de novo depois). Sem
// isso, cada clique em "Baixar" virava um registro duplicado no Histórico,
// e um deles podia ficar com "validação de WhatsApp: não" mesmo depois de
// validar de verdade — só porque era a cópia mais antiga.
async function updateHistoryEntry(id, entry) {
  await q(
    `UPDATE history SET total=$1, valid=$2, invalid=$3, duplicates=$4, no_whatsapp=$5,
                        hsm_count=$6, file_parts=$7, whatsapp_validated=$8, ts=now()
     WHERE id=$9`,
    [
      entry.total || 0, entry.valid || 0, entry.invalid || 0, entry.duplicates || 0, entry.noWhatsApp || 0,
      entry.hsmCount != null ? entry.hsmCount : null, entry.fileParts != null ? entry.fileParts : null,
      !!entry.whatsappValidated, id,
    ]
  );
}

// =====================================================================
// AGENDAMENTO — mesma lógica de formatação do navegador, portada pro
// servidor, para poder rodar sozinha no horário marcado.
// =====================================================================

function readSpreadsheetRowsFromBuffer(buffer, ext) {
  let wb;
  if (ext === '.csv') {
    wb = XLSX.read(buffer.toString('utf-8'), { type: 'string' });
  } else {
    wb = XLSX.read(buffer, { type: 'buffer' });
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
}

// ---- Créditos: checagem e desconto compartilhados entre o proxy ao vivo e o agendador ----
async function resolveCreditSource(user) {
  if (user.teamId) {
    const team = await findTeam(user.teamId);
    if (team) return { creditSource: 'team', effectiveCredits: team.credits, team };
  }
  return { creditSource: 'user', effectiveCredits: user.credits, team: null };
}

async function checkCreditsSufficient(user, count) {
  const { creditSource, effectiveCredits, team } = await resolveCreditSource(user);
  // Time pós-pago não trava por falta de crédito — o uso é ilimitado e fica
  // registrado no livro-razão pra fechar a conta no fim do ciclo.
  if (creditSource === 'team' && team && team.billingType === 'pospago') {
    return { ok: true, creditSource, team, effectiveCredits: null };
  }
  if (effectiveCredits === null || effectiveCredits === undefined) return { ok: true, creditSource, team, effectiveCredits };
  if (effectiveCredits < count) {
    return {
      ok: false, creditSource, team, effectiveCredits,
      message: creditSource === 'team'
        ? `O time "${team.name}" tem ${effectiveCredits} crédito(s), mas essa verificação precisa de ${count}. Peça a um administrador para adicionar créditos ao time.`
        : `Você tem ${effectiveCredits} crédito(s), mas essa verificação precisa de ${count}. Peça a um administrador para adicionar créditos.`,
    };
  }
  return { ok: true, creditSource, team, effectiveCredits };
}

// Grava no livro-razão de uso (só times pós-pagos) — cada linha guarda o
// preço por crédito NAQUELE momento, pra relatórios já fechados não mudarem
// de valor se o preço do time for reajustado depois.
async function logCreditUsage(team, creditType, quantity, fileName, source) {
  if (!team || team.billingType !== 'pospago' || quantity <= 0) return;
  const unitPrice = creditType === 'link' ? team.pricePerCreditLink : team.pricePerCreditBase;
  const price = (unitPrice === null || unitPrice === undefined) ? 0 : Number(unitPrice);
  const amount = price * quantity;
  await q(
    'INSERT INTO credit_usage_log (team_id, credit_type, quantity, unit_price, amount, file_name, source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [team.id, creditType, quantity, price, amount, fileName || null, source || 'sistema']
  );
}

async function deductCreditsFor(creditSource, team, username, count, fileName, source) {
  if (count <= 0) return;
  if (creditSource === 'team' && team && team.billingType === 'pospago') {
    await logCreditUsage(team, 'base', count, fileName, source);
    return;
  }
  if (creditSource === 'team' && team) {
    await q('UPDATE teams SET credits = GREATEST(0, COALESCE(credits,0) - $1) WHERE id = $2', [count, team.id]);
  } else {
    await q('UPDATE users SET credits = GREATEST(0, COALESCE(credits,0) - $1) WHERE username = $2', [count, username]);
  }
}

// ---- Créditos de link (encurtador) — mesmo modelo dos créditos de validação, pool separado ----
async function resolveLinkCreditSource(user) {
  if (user.teamId) {
    const team = await findTeam(user.teamId);
    if (team) return { creditSource: 'team', effectiveCredits: team.linkCredits, team };
  }
  return { creditSource: 'user', effectiveCredits: user.linkCredits, team: null };
}

async function checkLinkCreditsSufficient(user, count) {
  const { creditSource, effectiveCredits, team } = await resolveLinkCreditSource(user);
  if (creditSource === 'team' && team && team.billingType === 'pospago') {
    return { ok: true, creditSource, team, effectiveCredits: null };
  }
  if (effectiveCredits === null || effectiveCredits === undefined) return { ok: true, creditSource, team, effectiveCredits };
  if (effectiveCredits < count) {
    return {
      ok: false, creditSource, team, effectiveCredits,
      message: creditSource === 'team'
        ? `O time "${team.name}" tem ${effectiveCredits} crédito(s) de link, mas gerar isso precisa de ${count}. Peça a um administrador para adicionar créditos de link ao time.`
        : `Você tem ${effectiveCredits} crédito(s) de link, mas gerar isso precisa de ${count}. Peça a um administrador para adicionar créditos de link.`,
    };
  }
  return { ok: true, creditSource, team, effectiveCredits };
}

async function deductLinkCreditsFor(creditSource, team, username, count) {
  if (count <= 0) return;
  if (creditSource === 'team' && team && team.billingType === 'pospago') {
    await logCreditUsage(team, 'link', count);
    return;
  }
  if (creditSource === 'team' && team) {
    await q('UPDATE teams SET link_credits = GREATEST(0, COALESCE(link_credits,0) - $1) WHERE id = $2', [count, team.id]);
  } else {
    await q('UPDATE users SET link_credits = GREATEST(0, COALESCE(link_credits,0) - $1) WHERE username = $2', [count, username]);
  }
}

// =====================================================================
// MÓDULO FINANCEIRO — fechamento automático de ciclo dos times pós-pagos,
// geração do PDF da fatura, e o dashboard de faturas (pendente/pago).
// =====================================================================

function brl(n) {
  return 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Preço por crédito costuma ter 3 casas (ex: R$ 0,007) — 2 casas arredondaria
// pra R$ 0,01 e o total não bateria mais com a soma das linhas.
function brlUnit(n) {
  return 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
function numBR(n) {
  return (Number(n) || 0).toLocaleString('pt-BR');
}
// Título em versalete espaçado (ex.: "RELATÓRIO FINANCEIRO" -> "R E L A T
// Ó R I O   F I N A N C E I R O"), pra imitar o letter-spacing do modelo
// visual que o cliente mandou — pdf-lib não tem tracking nativo pra texto.
function spacedCaps(s) {
  return String(s).toUpperCase().split('').join(' ');
}
// Logo (só o símbolo hexagonal, sem o nome por extenso) — o mesmo arquivo já
// usado no cabeçalho do login/dashboard, carregado uma vez na subida do
// servidor. Fica em bytes na memória (não em disco variável), então funciona
// igual em qualquer ambiente sem precisar reconfigurar nada.
const LOGO_PNG_BYTES = fs.readFileSync(path.join(__dirname, 'assets', 'logo-corbantech.png'));

function fitText(font, text, size, maxWidth) {
  const t = String(text || '');
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
  let cut = t;
  while (cut.length > 1 && font.widthOfTextAtSize(cut + '…', size) > maxWidth) cut = cut.slice(0, -1);
  return cut + '…';
}

// Monta o PDF da fatura, no layout que o cliente definiu (modelo enviado por
// ele): cabeçalho com a logo e os dados de quem emite, bloco do cliente/time,
// período de referência, uma linha por ARQUIVO processado no formatador de
// base (só créditos de formatação — o gerador de link fica de fora do
// relatório por pedido explícito), total geral e instruções de pagamento.
// Pura JavaScript (pdf-lib), sem dependência nativa — paginação manual porque
// pdf-lib não flui texto/tabelas automaticamente entre páginas.
async function buildInvoicePdf(invoice, fileRows, company) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logoImage = await doc.embedPng(LOGO_PNG_BYTES);

  const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;
  const dark = rgb(0.11, 0.13, 0.18);
  const gray = rgb(0.45, 0.47, 0.52);
  const grayLight = rgb(0.62, 0.64, 0.68);
  const line = rgb(0.85, 0.86, 0.89);
  const hairline = rgb(0.92, 0.93, 0.95);
  const pendenteBg = rgb(0.98, 0.93, 0.83); const pendenteText = rgb(0.62, 0.4, 0.04);
  const pagoBg = rgb(0.85, 0.97, 0.92); const pagoText = rgb(0.0, 0.5, 0.38);
  const fmtDate = (d) => new Date(d).toLocaleDateString('pt-BR');
  const fmtDateTime = (d) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // colunas da tabela alinhadas à direita — guardo o x do fim de cada uma
  const colEnd = { qty: 400, price: 468, total: PAGE_W - MARGIN };

  let page, y;
  const isPago = invoice.status === 'pago';

  function drawRight(text, xEnd, yPos, size, f, color) {
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: xEnd - w, y: yPos, size, font: f, color });
  }

  function drawFooterDisclaimer() {
    const fy = 56;
    page.drawLine({ start: { x: MARGIN, y: fy + 22 }, end: { x: PAGE_W - MARGIN, y: fy + 22 }, thickness: 0.75, color: line });
    page.drawText('Fatura referente a créditos consumidos na plataforma Formatador de Base para Disparo.', { x: MARGIN, y: fy + 8, size: 7.5, font, color: grayLight });
    page.drawText('Documento gerado automaticamente pelo sistema CorbanTech — não requer assinatura.', { x: MARGIN, y: fy - 3, size: 7.5, font, color: grayLight });
    const footRight = `${invoice.number} · ${company.companySite || 'corbantech.digital'}`;
    drawRight(footRight, PAGE_W - MARGIN, fy + 8, 7.5, font, grayLight);
  }

  function newPage(withFullHeader) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - 55;
    if (withFullHeader) {
      // ---- logo + marca, dados de quem emite (esquerda) ----
      const logoH = 30, logoW = logoH * (logoImage.width / logoImage.height);
      page.drawImage(logoImage, { x: MARGIN, y: y - logoH + 6, width: logoW, height: logoH });
      page.drawText((company.companyName || 'CorbanTech'), { x: MARGIN + logoW + 10, y: y - 15, size: 15, font: bold, color: dark });

      // ---- número/status (direita) ----
      drawRight(spacedCaps('Relatório financeiro'), PAGE_W - MARGIN, y, 8, font, gray);
      drawRight(invoice.number, PAGE_W - MARGIN, y - 22, 20, bold, dark);
      drawRight(`Emitido em ${fmtDate(invoice.generatedAt)}`, PAGE_W - MARGIN, y - 37, 9, font, gray);
      const badgeText = isPago ? 'Pago' : 'Pendente';
      const badgeSize = 9;
      const badgeTextW = bold.widthOfTextAtSize(badgeText, badgeSize);
      const badgeW = badgeTextW + 18, badgeH = 17;
      const badgeX = PAGE_W - MARGIN - badgeW, badgeY = y - 58;
      page.drawRectangle({ x: badgeX, y: badgeY, width: badgeW, height: badgeH, color: isPago ? pagoBg : pendenteBg });
      page.drawText(badgeText, { x: badgeX + 9, y: badgeY + 5, size: badgeSize, font: bold, color: isPago ? pagoText : pendenteText });

      y -= 78;
      page.drawText((company.companyName || 'CorbanTech LTDA'), { x: MARGIN, y, size: 10, font: bold, color: dark });
      y -= 13;
      const cnpjLine = company.companyCnpj ? `CNPJ ${company.companyCnpj}` : '';
      if (cnpjLine) { page.drawText(cnpjLine, { x: MARGIN, y, size: 9, font, color: gray }); y -= 12; }
      const contactLine = [company.companyEmail, company.companyPhone].filter(Boolean).join(' · ');
      if (contactLine) { page.drawText(contactLine, { x: MARGIN, y, size: 9, font, color: gray }); y -= 12; }

      y -= 14;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.3, color: dark });
      y -= 28;

      // ---- cliente/time (esquerda) + período (direita) ----
      page.drawText(spacedCaps('Cliente / Time'), { x: MARGIN, y, size: 8, font, color: gray });
      const rightColX = 330;
      page.drawText(spacedCaps('Período de referência'), { x: rightColX, y, size: 8, font, color: gray });
      y -= 20;

      const avatarSize = 22;
      const teamLetter = ((invoice.teamName || '?').trim()[0] || '?').toUpperCase();
      page.drawRectangle({ x: MARGIN, y: y - avatarSize + 15, width: avatarSize, height: avatarSize, color: dark });
      const letterW = bold.widthOfTextAtSize(teamLetter, 11);
      page.drawText(teamLetter, { x: MARGIN + (avatarSize - letterW) / 2, y: y - avatarSize + 15 + 6, size: 11, font: bold, color: rgb(1, 0.827, 0.047) });
      page.drawText(fitText(bold, invoice.teamName || '—', 13.5, 220), { x: MARGIN + avatarSize + 10, y, size: 13.5, font: bold, color: dark });

      const periodStr = `${fmtDate(invoice.periodStart)} – ${fmtDate(invoice.periodEnd)}`;
      page.drawText(periodStr, { x: rightColX, y, size: 13.5, font: bold, color: dark });

      y -= 18;
      let leftY = y, rightY = y;
      if (invoice.teamCnpj) { page.drawText(`CNPJ ${invoice.teamCnpj}`, { x: MARGIN + avatarSize + 10, y: leftY, size: 9, font, color: gray }); leftY -= 12; }
      if (invoice.teamResponsavelNome) { page.drawText(`Responsável: ${invoice.teamResponsavelNome}`, { x: MARGIN + avatarSize + 10, y: leftY, size: 9, font, color: gray }); leftY -= 12; }
      if (invoice.teamResponsavelEmail) { page.drawText(invoice.teamResponsavelEmail, { x: MARGIN + avatarSize + 10, y: leftY, size: 9, font, color: gray }); leftY -= 12; }

      const cycleLabel = invoice.billingCycleDays ? `Ciclo de ${invoice.billingCycleDays} dia(s)` : 'Fechamento de ciclo';
      page.drawText(cycleLabel, { x: rightColX, y: rightY, size: 9, font, color: gray }); rightY -= 12;

      y = Math.min(leftY, rightY) - 16;

      page.drawText('Detalhamento do uso', { x: MARGIN, y, size: 12.5, font: bold, color: dark });
      drawRight('Valores em reais (BRL)', PAGE_W - MARGIN, y, 8.5, font, grayLight);
      y -= 22;
    } else {
      // páginas de continuação: sem cabeçalho completo, só a tabela seguindo
      y -= 5;
    }

    // ---- cabeçalho da tabela (toda página) ----
    // Sem o tracking manual do spacedCaps aqui: as colunas numéricas são
    // estreitas demais pro texto espaçado — usar letras coladas evita que um
    // cabeçalho invada o espaço do vizinho (bug visto e corrigido em teste).
    page.drawText('ARQUIVO PROCESSADO', { x: MARGIN, y, size: 8, font: bold, color: gray });
    drawRight('CRÉDITOS', colEnd.qty, y, 8, bold, gray);
    drawRight('VALOR UNIT.', colEnd.price, y, 8, bold, gray);
    drawRight('SUBTOTAL', colEnd.total, y, 8, bold, gray);
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: line });
    y -= 20;
  }

  newPage(true);
  const ROW_H = 24;
  const FOOTER_RESERVE = 92; // espaço mínimo garantido pro rodapé de toda página
  const SUMMARY_RESERVE = 190; // espaço extra que o bloco de total+pagamento precisa, só na última página

  if (!fileRows.length) {
    page.drawText('Nenhum arquivo processado neste ciclo.', { x: MARGIN, y, size: 10, font, color: gray });
    y -= ROW_H;
  }

  fileRows.forEach((r, idx) => {
    const isLast = idx === fileRows.length - 1;
    const reserve = FOOTER_RESERVE + (isLast ? SUMMARY_RESERVE : 0);
    if (y - ROW_H < reserve) newPage(false);

    const label = r.apiAggregate
      ? 'Consultas via API (validação de WhatsApp)'
      : (r.file_name ? r.file_name : `Processamento em ${fmtDateTime(r.created_at)}`);
    page.drawText(fitText(font, label, 9.5, 300), { x: MARGIN, y, size: 9.5, font, color: dark });
    drawRight(numBR(r.quantity), colEnd.qty, y, 9.5, font, dark);
    drawRight(brlUnit(r.unit_price), colEnd.price, y, 9.5, font, dark);
    drawRight(brl(r.amount), colEnd.total, y, 9.5, font, dark);
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: hairline });
    y -= (ROW_H - 8);
  });

  // ---- resumo + total geral ----
  if (y - 60 < FOOTER_RESERVE + SUMMARY_RESERVE) newPage(false);
  y -= 12;
  const summaryFileCount = fileRows.filter(r => !r.apiAggregate).length;
  const summaryLine = fileRows.some(r => r.apiAggregate)
    ? `${summaryFileCount} arquivo(s) processado(s) + consultas via API no ciclo`
    : `${summaryFileCount} arquivo(s) processado(s) no ciclo`;
  page.drawText(summaryLine, { x: MARGIN, y, size: 9, font, color: gray });
  drawRight(spacedCaps('Total geral'), PAGE_W - MARGIN, y + 6, 8, font, grayLight);
  y -= 13;
  page.drawText(`${numBR(invoice.creditsBaseUsed)} créditos consumidos`, { x: MARGIN, y, size: 9, font, color: gray });
  drawRight(brl(invoice.amountTotal), PAGE_W - MARGIN, y - 6, 19, bold, dark);

  // ---- pagamento ----
  y -= 46;
  page.drawText(spacedCaps('Pagamento'), { x: MARGIN, y, size: 8.5, font: bold, color: gray });
  y -= 16;
  const pixParts = [company.companyPixKey ? `CNPJ ${company.companyPixKey}` : '', company.companyPixBanco, company.companyName].filter(Boolean);
  page.drawText(`PIX — ${pixParts.join(' · ')}`, { x: MARGIN, y, size: 10, font: bold, color: dark });
  y -= 16;
  const disclaimer1 = `Após o pagamento, envie o comprovante para ${company.companyEmail || 'contato@corbantech.digital'}. Este documento é um`;
  const disclaimer2 = 'demonstrativo de consumo e não substitui a nota fiscal de serviço.';
  page.drawText(disclaimer1, { x: MARGIN, y, size: 8.5, font, color: gray });
  y -= 12;
  page.drawText(disclaimer2, { x: MARGIN, y, size: 8.5, font, color: gray });

  // ---- rodapé (repete em toda página já desenhada) ----
  doc.getPages().forEach(p => { page = p; drawFooterDisclaimer(); });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function rowToInvoice(r) {
  if (!r) return null;
  return {
    id: r.id, number: 'FIN-' + String(r.id).padStart(4, '0'), teamId: r.team_id, teamName: r.team_name,
    periodStart: r.period_start, periodEnd: r.period_end,
    creditsBaseUsed: r.credits_base_used, creditsLinkUsed: r.credits_link_used,
    pricePerCreditBase: r.price_per_credit_base === null ? null : Number(r.price_per_credit_base),
    pricePerCreditLink: r.price_per_credit_link === null ? null : Number(r.price_per_credit_link),
    amountBase: Number(r.amount_base), amountLink: Number(r.amount_link), amountTotal: Number(r.amount_total),
    status: r.status, generatedAt: r.generated_at, paidAt: r.paid_at,
    hasPdf: !!r.pdf_data,
  };
}

// Fecha o ciclo de um time pós-pago: soma o uso registrado no livro-razão
// desde o início do ciclo até agora, gera a fatura (com o PDF já pronto) e
// avança o time pro próximo ciclo a partir de agora.
//
// Importante (pedido explícito do cliente): o valor cobrado e o PDF da
// fatura consideram só os créditos de FORMATAÇÃO DE BASE. O gerador de link
// continua ilimitado e registrado no livro-razão pros times pós-pagos, mas
// não entra no valor total nem aparece no relatório — fica só como registro
// interno, caso um dia isso mude.
async function closeBillingCycle(team, periodEnd) {
  const periodStart = team.cycleStart || periodEnd;
  const { rows } = await q(
    `SELECT credit_type, COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(amount),0) AS amount
     FROM credit_usage_log WHERE team_id=$1 AND created_at >= $2 AND created_at < $3
     GROUP BY credit_type`,
    [team.id, periodStart, periodEnd]
  );
  const byType = {};
  rows.forEach(r => { byType[r.credit_type] = { qty: Number(r.qty), amount: Number(r.amount) }; });
  const creditsBaseUsed = (byType.base && byType.base.qty) || 0;
  const creditsLinkUsed = (byType.link && byType.link.qty) || 0;
  const amountBase = (byType.base && byType.base.amount) || 0;
  const amountLink = (byType.link && byType.link.amount) || 0;
  const amountTotal = amountBase; // gerador de link não é cobrado neste relatório (ver comentário acima)

  // Linhas do formatador de base (uma por arquivo, como sempre) — só as de
  // origem 'sistema'. O consumo via API (source='api') não tem arquivo, então
  // entra como UMA linha agregada no fim, separada das demais (pedido explícito).
  const { rows: sistemaRows } = await q(
    `SELECT file_name, quantity, unit_price, amount, created_at FROM credit_usage_log
     WHERE team_id=$1 AND credit_type='base' AND created_at >= $2 AND created_at < $3 AND source='sistema'
     ORDER BY created_at ASC`,
    [team.id, periodStart, periodEnd]
  );
  const { rows: apiAggRows } = await q(
    `SELECT COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(amount),0) AS amount, MAX(unit_price) AS unit_price
     FROM credit_usage_log WHERE team_id=$1 AND credit_type='base' AND created_at >= $2 AND created_at < $3 AND source='api'`,
    [team.id, periodStart, periodEnd]
  );
  const apiQty = Number(apiAggRows[0] && apiAggRows[0].qty) || 0;
  const fileRows = sistemaRows.slice();
  if (apiQty > 0) {
    fileRows.push({
      apiAggregate: true, file_name: null,
      quantity: apiQty,
      unit_price: apiAggRows[0].unit_price,
      amount: Number(apiAggRows[0].amount) || 0,
      created_at: periodEnd,
    });
  }
  const company = await readSettings();

  // Reserva o próximo número da sequência de faturas ANTES de montar o PDF,
  // pra poder já imprimir "FIN-000X" dentro do próprio documento.
  const { rows: idRows } = await q(`SELECT nextval(pg_get_serial_sequence('invoices','id')) AS id`);
  const invoiceId = Number(idRows[0].id);

  const invoiceDraft = {
    id: invoiceId, number: 'FIN-' + String(invoiceId).padStart(4, '0'),
    teamName: team.name, teamCnpj: team.cnpj, teamResponsavelNome: team.responsavelNome, teamResponsavelEmail: team.responsavelEmail,
    periodStart, periodEnd, billingCycleDays: team.billingCycleDays,
    creditsBaseUsed, creditsLinkUsed,
    pricePerCreditBase: team.pricePerCreditBase, pricePerCreditLink: team.pricePerCreditLink,
    amountBase, amountLink, amountTotal, status: 'pendente', generatedAt: new Date(),
  };
  const pdfBuffer = await buildInvoicePdf(invoiceDraft, fileRows, company);

  const { rows: inserted } = await q(
    `INSERT INTO invoices (id, team_id, team_name, period_start, period_end, credits_base_used, credits_link_used,
       price_per_credit_base, price_per_credit_link, amount_base, amount_link, amount_total, status, pdf_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pendente',$13) RETURNING *`,
    [invoiceId, team.id, team.name, periodStart, periodEnd, creditsBaseUsed, creditsLinkUsed,
      team.pricePerCreditBase, team.pricePerCreditLink, amountBase, amountLink, amountTotal, pdfBuffer]
  );
  await q('UPDATE teams SET cycle_start=$1 WHERE id=$2', [periodEnd, team.id]);
  return rowToInvoice(inserted[0]);
}

let billingCycleCheckRunning = false;
async function checkDueBillingCycles() {
  if (billingCycleCheckRunning) return;
  billingCycleCheckRunning = true;
  try {
    const { rows } = await q(
      `SELECT * FROM teams WHERE billing_type='pospago' AND billing_cycle_days IS NOT NULL
       AND cycle_start IS NOT NULL AND cycle_start + (billing_cycle_days || ' days')::interval <= now()`
    );
    for (const row of rows) {
      const team = rowToTeam(row);
      try {
        await closeBillingCycle(team, new Date());
      } catch (e) {
        console.error(`Erro ao fechar o ciclo financeiro do time "${team.name}":`, e.message);
      }
    }
  } catch (e) {
    console.error('Erro no verificador de ciclos financeiros:', e.message);
  } finally {
    billingCycleCheckRunning = false;
  }
}

// ---- Chamadas à API de validação a partir do servidor ----
// Importante: nenhuma resposta bruta do fornecedor (texto, JSON, mensagens de
// erro) deve vazar pro cliente/navegador — só mensagens genéricas, escritas
// por nós. Detalhes reais de erro só vão pro console do servidor (console.error),
// que o cliente final nunca tem acesso.

// eKYC Pro (docs.ekycpro.com) — consulta síncrona de 1 número, usada só pela
// rota /api/v1/whatsapp/check (consulta individual via API). Diferente do
// checknumber.ai, tem endpoint de verdade pra 1 número (POST /v1/check),
// sem mínimo de lote — foi criado exatamente pra resolver isso (ver
// LEIA-ME-CORRECOES.md, incidente do mínimo de 500 no checknumber.ai).
//
// ATENÇÃO: a documentação oficial mostra o mesmo endpoint em dois domínios
// diferentes (api.ekycpro.com e api.ekycpro.ai) em páginas diferentes do
// próprio site deles — inconsistência da documentação, não nossa. Confirme
// com o painel/e-mail de boas-vindas da eKYC Pro qual domínio é o correto
// pra sua conta antes de ativar em produção; até lá, o padrão abaixo é
// api.ekycpro.com (o mesmo domínio citado nas outras chamadas de exemplo do
// próprio site deles, ex.: VK e Telegram).
const EKYCPRO_BASE_URL = process.env.EKYCPRO_BASE_URL || 'https://api.ekycpro.com';

async function checkWhatsappEkycPro(apiKey, fullDigits) {
  const resp = await fetch(`${EKYCPRO_BASE_URL}/v1/check`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ service_type: 'ws', identifier: '+' + fullDigits }),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = null; }

  if (!resp.ok || !data || data.success !== true) {
    console.error('[ekycpro] recusou a requisição:', resp.status, text.slice(0, 500));
    throw new Error(`A eKYC Pro recusou a requisição (HTTP ${resp.status}).`);
  }
  // data.data.registered: true/false — presente mesmo quando o número não
  // tem WhatsApp (isso não é erro, é um resultado válido).
  return { hasWhatsapp: Boolean(data.data && data.data.registered) };
}

async function createWaValidationTask(apiKey, numbersE164) {
  const txt = numbersE164.join('\n');
  const fd = new FormData();
  fd.append('file', new Blob([txt], { type: 'text/plain' }), 'numeros.txt');
  fd.append('task_type', 'ws');
  const resp = await fetch('https://api.checknumber.ai/v1/tasks', { method: 'POST', headers: { 'X-API-Key': apiKey }, body: fd });
  const text = await resp.text();
  if (!resp.ok) {
    console.error('[validador-whatsapp] recusou a requisição:', resp.status, text.slice(0, 500));
    throw new Error(`O serviço de verificação recusou a requisição (HTTP ${resp.status}).`);
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { data = {}; }
  if (!data.task_id) {
    console.error('[validador-whatsapp] resposta sem task_id:', text.slice(0, 500));
    throw new Error('O serviço de verificação não retornou um identificador de tarefa.');
  }
  return data.task_id;
}

function sleepSrv(ms) { return new Promise(res => setTimeout(res, ms)); }

async function pollWaValidationTask(apiKey, taskId) {
  const maxTries = 180;
  for (let i = 0; i < maxTries; i++) {
    await sleepSrv(10000);
    const fd = new FormData();
    fd.append('task_id', taskId);
    const resp = await fetch('https://api.checknumber.ai/v1/gettasks', { method: 'POST', headers: { 'X-API-Key': apiKey }, body: fd });
    if (!resp.ok) {
      console.error('[validador-whatsapp] falha ao consultar status:', resp.status);
      throw new Error(`Falha ao consultar o status (HTTP ${resp.status}).`);
    }
    const data = await resp.json().catch(() => ({}));
    if (data.status === 'failed' || data.error) {
      console.error('[validador-whatsapp] falha reportada:', JSON.stringify(data).slice(0, 500));
      throw new Error('O serviço de verificação reportou uma falha na verificação.');
    }
    if (data.status === 'exported' && data.result_url) return data.result_url;
  }
  throw new Error('A verificação demorou demais e não foi concluída a tempo.');
}

async function downloadValidSetSrv(resultUrl) {
  const resp = await fetch(resultUrl);
  if (!resp.ok) throw new Error(`Falha ao baixar o resultado (HTTP ${resp.status}).`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const validSet = new Set();
  let textFiles = [];
  if (resultUrl.toLowerCase().includes('.zip')) {
    const zip = await JSZip.loadAsync(buffer);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      textFiles.push(await zip.files[name].async('string'));
    }
  } else {
    textFiles = [buffer.toString('utf-8')];
  }
  textFiles.forEach(txt => {
    txt.split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      const digits = (line.match(/\d{8,15}/) || [null])[0];
      if (!digits) return;
      const positive = /\byes\b|\btrue\b|\bvalid\b|\bregistered\b/i.test(line);
      const negative = /\bno\b|\bfalse\b|\binvalid\b|\bnot[_ ]?registered\b/i.test(line);
      if (positive && !negative) validSet.add(digits);
    });
  });
  return validSet;
}

// ---- Jobs agendados (persistidos no Postgres) ----
function rowToJob(r) {
  if (!r) return null;
  return {
    id: r.id, username: r.username, name: r.name, cliente: r.cliente, filename: r.filename,
    uploadExt: r.upload_ext, platform: r.platform, ddiPadrao: r.ddi_padrao,
    hsmGroups: r.hsm_groups, splitParts: r.split_parts, variables: r.variables,
    scheduledAt: r.scheduled_at, status: r.status, createdAt: r.created_at,
    startedAt: r.started_at, finishedAt: r.finished_at, error: r.error,
    resultFilename: r.result_filename, contentType: r.content_type, stats: r.stats,
  };
}

async function readScheduledJobs(usernameFilter) {
  const { rows } = usernameFilter
    ? await q('SELECT id,username,name,cliente,filename,upload_ext,platform,ddi_padrao,hsm_groups,split_parts,variables,scheduled_at,status,created_at,started_at,finished_at,error,result_filename,content_type,stats FROM scheduled_jobs WHERE username=$1 ORDER BY created_at DESC', [usernameFilter])
    : await q('SELECT id,username,name,cliente,filename,upload_ext,platform,ddi_padrao,hsm_groups,split_parts,variables,scheduled_at,status,created_at,started_at,finished_at,error,result_filename,content_type,stats FROM scheduled_jobs ORDER BY created_at DESC');
  const avatarMap = await getUserAvatarMap();
  return rows.map(r => {
    const job = rowToJob(r);
    job.logoUrl = (avatarMap[job.username] && avatarMap[job.username].logoUrl) || null;
    return job;
  });
}

async function findScheduledJobFull(id) {
  const { rows } = await q('SELECT * FROM scheduled_jobs WHERE id = $1', [id]);
  return rows[0] || null;
}

async function readDueJobIds() {
  const { rows } = await q(`SELECT id FROM scheduled_jobs WHERE status='agendado' AND scheduled_at <= now()`);
  return rows.map(r => r.id);
}

// ---- Execução de um job agendado (formatação + validação de WhatsApp) ----
async function runScheduledJob(jobId) {
  const jobRow = await findScheduledJobFull(jobId);
  if (!jobRow) return;
  const job = rowToJob(jobRow);
  try {
    await q(`UPDATE scheduled_jobs SET status='processando', started_at=now() WHERE id=$1`, [jobId]);

    const rows = readSpreadsheetRowsFromBuffer(jobRow.upload_data, jobRow.upload_ext);
    if (!rows || rows.length < 2) throw new Error('O arquivo parece vazio.');

    const parsed = job.platform === 'hyperflow' ? WatiHyperflowRules.processHyperflow(rows, job.ddiPadrao || '55') : WatiHyperflowRules.processWati(rows, job.ddiPadrao || '55');
    if (parsed.parsedRows.length < 500) {
      throw new Error(`O validador exige no mínimo 500 números válidos por lote. Essa base tem ${parsed.parsedRows.length} válidos.`);
    }

    const user = await findUserRecord(job.username);
    if (!user) throw new Error('Usuário dono do agendamento não existe mais.');

    const apiKey = (await readSettings()).waApiKey;
    if (!apiKey) throw new Error('A chave do validador de WhatsApp ainda não foi configurada em /admin.');

    const credCheck = await checkCreditsSufficient(user, parsed.parsedRows.length);
    if (!credCheck.ok) throw new Error(credCheck.message);

    const ddiFallback = job.ddiPadrao || '55';
    const numbersE164 = parsed.parsedRows.map(r => '+' + (r.ddi || ddiFallback) + r.phone);
    const taskId = await createWaValidationTask(apiKey, numbersE164);
    const resultUrl = await pollWaValidationTask(apiKey, taskId);
    const validSet = await downloadValidSetSrv(resultUrl);

    const before = parsed.parsedRows.length;
    const withWa = parsed.parsedRows.filter(r => validSet.has((r.ddi || ddiFallback) + r.phone));
    const noWhatsAppCount = before - withWa.length;

    await deductCreditsFor(credCheck.creditSource, credCheck.team, job.username, before, job.filename);

    const chunks = WatiHyperflowRules.buildChunks(withWa, job.splitParts || 1);
    let resultBuffer, resultFilename, contentType;
    let cursor = 0;
    if (chunks.length <= 1) {
      resultBuffer = Buffer.from(WatiHyperflowRules.rowsToCsv(chunks[0] || [], 0, job.platform, job.variables, job.hsmGroups, withWa.length, parsed.hyperflowHasNome, parsed.hyperflowHasCpf, parsed.extraCols), 'utf-8');
      resultFilename = 'base_pronta_para_disparo.csv';
      contentType = 'text/csv; charset=utf-8';
    } else {
      const zip = new JSZip();
      chunks.forEach((chunk, i) => {
        const num = String(i + 1).padStart(2, '0');
        zip.file(`base_parte_${num}_de_${chunks.length}.csv`, WatiHyperflowRules.rowsToCsv(chunk, cursor, job.platform, job.variables, job.hsmGroups, withWa.length, parsed.hyperflowHasNome, parsed.hyperflowHasCpf, parsed.extraCols));
        cursor += chunk.length;
      });
      resultBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      resultFilename = 'bases_divididas.zip';
      contentType = 'application/zip';
    }

    const stats = { total: parsed.originalTotalCount, valid: withWa.length, invalid: parsed.invalidRows.length, duplicates: parsed.duplicateCount, noWhatsApp: noWhatsAppCount };

    await appendHistory({ user: job.username, name: user.name, cliente: job.cliente, teamId: user.teamId || null, filename: job.filename, platform: job.platform, scheduled: true, ...stats });

    await q(
      `UPDATE scheduled_jobs SET status='concluido', finished_at=now(), result_data=$1, result_filename=$2, content_type=$3, stats=$4, error=NULL WHERE id=$5`,
      [resultBuffer, resultFilename, contentType, JSON.stringify(stats), jobId]
    );
    await logAdminAction(job.username, 'agendamento_concluido', job.filename, `${stats.valid} de ${stats.total} prontos para disparo`);
  } catch (err) {
    await q(`UPDATE scheduled_jobs SET status='erro', finished_at=now(), error=$1 WHERE id=$2`, [err.message, jobId]);
  }
}

let schedulerRunning = false;
async function checkDueScheduledJobs() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const ids = await readDueJobIds();
    for (const id of ids) await runScheduledJob(id);
  } catch (e) {
    console.error('Erro no verificador de agendamentos:', e.message);
  } finally {
    schedulerRunning = false;
  }
}

// ---------- Jobs de validação "ao vivo" (Formatador de base, sob demanda) ----------
// Guardados no Postgres (não em memória do processo) — pelo mesmo motivo dos
// agendamentos: sobrevive a um reinício do servidor (um deploy, por exemplo)
// no meio de uma verificação, sem quebrar o "retomar". O único propósito
// dessa tabela é nunca deixar o navegador ver o identificador/URL reais por
// trás da verificação de WhatsApp, nem a resposta bruta do fornecedor.
async function createLiveWaJob(username, providerTaskId) {
  const id = crypto.randomBytes(12).toString('hex');
  await q(
    'INSERT INTO live_wa_jobs (id, username, provider_task_id, status) VALUES ($1,$2,$3,$4)',
    [id, username, providerTaskId, 'processing']
  );
  return id;
}
async function getLiveWaJob(id, username) {
  if (!id) return null;
  const { rows } = await q('SELECT * FROM live_wa_jobs WHERE id=$1 AND username=$2', [id, username]);
  return rows[0] || null;
}
async function updateLiveWaJob(id, fields) {
  const sets = []; const params = []; let p = 1;
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=$${p++}`); params.push(v); }
  params.push(id);
  await q(`UPDATE live_wa_jobs SET ${sets.join(', ')} WHERE id=$${p}`, params);
}
async function deleteLiveWaJob(id) {
  await q('DELETE FROM live_wa_jobs WHERE id=$1', [id]);
}
async function pruneLiveWaJobs() {
  await q(`DELETE FROM live_wa_jobs WHERE created_at < now() - interval '1 hour'`);
}
// Consultas da API pública guardam mais tempo que os jobs "ao vivo" do
// navegador (aqui o cliente pode demorar pra consultar/receber o webhook) —
// 14 dias é suficiente pra qualquer reconciliação e não deixa a tabela crescer sem limite.
async function pruneApiWaChecks() {
  await q(`DELETE FROM api_wa_checks WHERE created_at < now() - interval '14 days'`);
}

async function pruneApiWaLotes() {
  await q(`DELETE FROM api_wa_lotes WHERE created_at < now() - interval '14 days'`);
}

// ---------- Servidor ----------
let LOGIN_REQUIRED = true;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // ---- Arquivos estáticos: /app.css, /assets/... (não exige sessão) ----
    const TIPOS_ASSET = {
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
      '.woff2': 'font/woff2'
    };
    if (req.method === 'GET' && pathname === '/app.css') {
      return sendFile(res, path.join(__dirname, 'app.css'), TIPOS_ASSET['.css']);
    }
    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      const nomeAsset = path.basename(pathname); // impede /assets/../server.js
      const tipoAsset = TIPOS_ASSET[path.extname(nomeAsset).toLowerCase()];
      if (!tipoAsset) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Tipo de arquivo não permitido.');
      }
      return sendFile(res, path.join(__dirname, 'assets', nomeAsset), tipoAsset);
    }
    if (req.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/favicon.png')) {
      return sendFile(res, path.join(__dirname, 'assets', 'favicon.png'), 'image/png');
    }
    if (req.method === 'GET' && pathname.startsWith('/js/')) {
      const nomeJs = path.basename(pathname); // impede /js/../server.js
      if (path.extname(nomeJs).toLowerCase() !== '.js') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Tipo de arquivo não permitido.');
      }
      return sendFile(res, path.join(__dirname, 'js', nomeJs), TIPOS_ASSET['.js']);
    }
    if (req.method === 'GET' && pathname.startsWith('/vendor/')) {
      // bibliotecas de terceiros auto-hospedadas (antes vinham de cdnjs.cloudflare.com)
      const nomeVendor = path.basename(pathname); // impede /vendor/../server.js
      if (path.extname(nomeVendor).toLowerCase() !== '.js') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Tipo de arquivo não permitido.');
      }
      return sendFile(res, path.join(__dirname, 'vendor', nomeVendor), TIPOS_ASSET['.js']);
    }

    // ---- Login (não exige sessão) ----
    if (req.method === 'GET' && pathname === '/login') {
      return sendFile(res, LOGIN_FILE, 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && pathname === '/login') {
      const body = await readBody(req);
      const { username, password } = parseFormUrlEncoded(body);
      const uname = username || '';

      if (isLocked(uname)) {
        res.writeHead(302, { Location: '/login?erro=bloqueado' });
        return res.end();
      }

      const user = await findUserRecord(uname);
      if (!user || user.active === false || !verifyPassword(password || '', user.passwordHash)) {
        registerFailedAttempt(uname);
        res.writeHead(302, { Location: '/login?erro=1' });
        return res.end();
      }
      clearAttempts(uname);
      const token = createSession(user.username);
      res.writeHead(302, { Location: '/', 'Set-Cookie': setCookieHeader(req, token, SESSION_TTL_MS / 1000) });
      return res.end();
    }

    if (req.method === 'GET' && pathname === '/logout') {
      const cookies = parseCookies(req);
      if (cookies['sid']) sessions.delete(cookies['sid']);
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
      return res.end();
    }

    // ---- Esqueci minha senha (não exige sessão) ----
    if (req.method === 'POST' && pathname === '/api/forgot-password') {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body.toString('utf-8')); } catch (e) { data = {}; }
      const uname = (data.username || '').trim();
      if (uname) {
        const user = await findUserRecord(uname);
        if (user) {
          const id = crypto.randomBytes(8).toString('hex');
          await q('INSERT INTO password_resets (id, username, name, status) VALUES ($1,$2,$3,$4)', [id, uname, user.name, 'pending']);
        }
      }
      return sendJson(res, 200, { ok: true, message: 'Se esse usuário existir, um administrador foi avisado para redefinir a senha.' });
    }

    // =====================================================================
    // API PÚBLICA — consulta avulsa de WhatsApp (autenticação por X-API-Key,
    // não por sessão/cookie). Fica FORA do gate de sessão de propósito: é
    // pensada pra ser chamada pelo sistema do cliente, número a número, ao
    // longo do dia — sem exigir lote mínimo (diferente do formatador/
    // agendamento, que continuam com a regra de sempre, intocada).
    //
    // IMPORTANTE: a resposta é SEMPRE imediata (202 + request_id). A
    // DigitalOcean App Platform derruba com 502 qualquer requisição que
    // demore demais pra responder (limite fixo da plataforma, não dá pra
    // configurar) — e o fornecedor da validação não é instantâneo nem pra 1
    // número só. Por isso o processamento roda em segundo plano; o
    // resultado é entregue por webhook (se o time tiver um configurado) e
    // sempre pode ser consultado depois pelo GET de status, como plano B.
    // =====================================================================
    async function authenticateApiTeam(req) {
      const providedKey = req.headers['x-api-key'];
      if (!providedKey) return { error: sendJson.bind(null, 401, { error: 'chave_ausente', message: 'Informe sua credencial no header X-API-Key.' }) };
      const team = await findTeamByApiKey(Array.isArray(providedKey) ? providedKey[0] : providedKey);
      if (!team) return { error: sendJson.bind(null, 401, { error: 'chave_invalida', message: 'Credencial inválida ou revogada.' }) };
      if (team.billingType !== 'pospago') {
        return { error: sendJson.bind(null, 403, { error: 'time_nao_elegivel', message: 'Essa credencial pertence a um time que não está mais no modelo pós-pago.' }) };
      }
      return { team };
    }

    // Envia o resultado pro webhook cadastrado (se houver). Uma tentativa só,
    // com timeout curto — o GET de status continua disponível como plano B
    // se a entrega falhar (rede instável do lado do cliente, etc).
    async function sendWebhookCallback(url, payload, checkId) {
      let delivered = false;
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'CorbanTech-Webhook/1.0' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(t);
        delivered = resp.ok;
      } catch (e) {
        console.error('[webhook whatsapp/check] falha ao entregar callback:', e.message);
      }
      await q('UPDATE api_wa_checks SET callback_delivered=$1 WHERE id=$2', [delivered, checkId]).catch(() => {});
    }

    // Roda o fluxo do fornecedor sem o request HTTP esperar — grava o
    // resultado, debita o crédito (só na conclusão) e dispara o webhook.
    // Usa a eKYC Pro (consulta síncrona de 1 número) — não o checknumber.ai,
    // que não tem endpoint de consulta avulsa de verdade (ver comentário em
    // checkWhatsappEkycPro). O contrato externo da rota (202 + polling via
    // GET /check/:id, ou callback_url) continua exatamente igual — só o
    // fornecedor por trás mudou.
    async function runApiWhatsappCheck(checkId, team, fullDigits, ekycproApiKey, callbackUrl) {
      try {
        const { hasWhatsapp } = await checkWhatsappEkycPro(ekycproApiKey, fullDigits);

        await q('UPDATE api_wa_checks SET status=$1, has_whatsapp=$2, finished_at=now() WHERE id=$3', ['done', hasWhatsapp, checkId]);
        await deductCreditsFor('team', team, null, 1, null, 'api');
        await appendHistory({
          user: null,
          name: `API · ${team.name}`,
          cliente: team.name,
          teamId: team.id,
          filename: null,
          platform: 'api',
          scheduled: false,
          total: 1,
          valid: hasWhatsapp ? 1 : 0,
          invalid: 0,
          duplicates: 0,
          noWhatsApp: hasWhatsapp ? 0 : 1,
          whatsappValidated: true,
        }).catch((e) => console.error('[api/whatsapp/check] falha ao gravar histórico:', e.message));
        if (callbackUrl) await sendWebhookCallback(callbackUrl, { request_id: checkId, phone: fullDigits, has_whatsapp: hasWhatsapp }, checkId);
      } catch (err) {
        console.error('[api/whatsapp/check] falha ao validar:', err.message);
        const message = 'Não foi possível validar esse número agora. Tente enviar uma nova consulta.';
        await q('UPDATE api_wa_checks SET status=$1, error_message=$2, finished_at=now() WHERE id=$3', ['error', message, checkId]).catch(() => {});
        if (callbackUrl) await sendWebhookCallback(callbackUrl, { request_id: checkId, phone: fullDigits, error: true, message }, checkId);
      }
    }

    // Envia o resultado de um LOTE pro webhook cadastrado (se houver) —
    // mesmo padrão do sendWebhookCallback de cima, só que aponta pra
    // api_wa_lotes em vez de api_wa_checks.
    async function sendWebhookCallbackLote(url, payload, loteId) {
      let delivered = false;
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'CorbanTech-Webhook/1.0' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(t);
        delivered = resp.ok;
      } catch (e) {
        console.error('[webhook whatsapp/check-lote] falha ao entregar callback:', e.message);
      }
      await q('UPDATE api_wa_lotes SET callback_delivered=$1 WHERE id=$2', [delivered, loteId]).catch(() => {});
    }

    // Roda o fluxo do LOTE sem o request HTTP esperar (pode levar minutos —
    // a checknumber.ai é assíncrona por natureza: cria a tarefa, espera,
    // baixa o resultado). Reaproveita EXATAMENTE as mesmas funções já usadas
    // pelo Formatador de base (createWaValidationTask, pollWaValidationTask,
    // downloadValidSetSrv) — nenhuma lógica nova de integração com o
    // fornecedor, só uma casca de API por cima do que já existe e já roda
    // em produção.
    async function runApiWhatsappCheckLote(loteId, team, phones, waApiKey, callbackUrl) {
      try {
        const taskId = await createWaValidationTask(waApiKey, phones);
        const resultUrl = await pollWaValidationTask(waApiKey, taskId);
        const validSet = await downloadValidSetSrv(resultUrl);

        const resultados = phones.map((telefone) => ({
          telefone,
          possui_whatsapp: validSet.has(telefone),
        }));

        await q('UPDATE api_wa_lotes SET status=$1, resultados=$2::jsonb, finished_at=now() WHERE id=$3', [
          'done',
          JSON.stringify(resultados),
          loteId,
        ]);
        await deductCreditsFor('team', team, null, phones.length, null, 'api');
        const comWhatsapp = resultados.filter((r) => r.possui_whatsapp).length;
        await appendHistory({
          user: null,
          name: `API (lote) · ${team.name}`,
          cliente: team.name,
          teamId: team.id,
          filename: null,
          platform: 'api',
          scheduled: false,
          total: phones.length,
          valid: comWhatsapp,
          invalid: 0,
          duplicates: 0,
          noWhatsApp: phones.length - comWhatsapp,
          whatsappValidated: true,
        }).catch((e) => console.error('[api/whatsapp/check-lote] falha ao gravar histórico:', e.message));
        if (callbackUrl) {
          await sendWebhookCallbackLote(callbackUrl, { lote_id: loteId, status: 'done', total: phones.length, resultados }, loteId);
        }
      } catch (err) {
        console.error('[api/whatsapp/check-lote] falha ao validar lote:', err.message);
        const message = 'Não foi possível validar esse lote agora. Tente enviar um novo.';
        await q('UPDATE api_wa_lotes SET status=$1, error_message=$2, finished_at=now() WHERE id=$3', ['error', message, loteId]).catch(() => {});
        if (callbackUrl) await sendWebhookCallbackLote(callbackUrl, { lote_id: loteId, status: 'error', message }, loteId);
      }
    }

    // Consulta em LOTE — pra parceiros de alto volume que topam esperar um
    // pouco (a checknumber.ai não tem endpoint instantâneo, só de lote) em
    // troca de um custo bem menor por número que a consulta individual
    // (ver /api/v1/whatsapp/check, que continua existindo e usando a eKYC
    // Pro — nenhuma mudança nela).
    const LIMITE_MINIMO_LOTE = 500; // mesma exigência da checknumber.ai
    if (req.method === 'POST' && pathname === '/api/v1/whatsapp/check-lote') {
      const auth = await authenticateApiTeam(req);
      if (auth.error) return auth.error(res);
      const { team } = auth;

      const rate = checkApiRateLimit(team.id);
      if (!rate.ok) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        return sendJson(res, 429, { error: 'limite_excedido', message: `Limite de ${API_RATE_LIMIT} requisições por minuto atingido. Tente novamente em ${rate.retryAfterSec}s.` });
      }

      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { error: 'json_invalido', message: 'Corpo da requisição precisa ser um JSON válido.' }); }

      if (!Array.isArray(data.phones)) {
        return sendJson(res, 400, { error: 'telefones_ausentes', message: 'Informe o campo "phones" como um array de números.' });
      }

      const ddiPadrao = String(data.ddi || '55').replace(/\D/g, '') || '55';
      const phones = [];
      for (const raw of data.phones) {
        let digits = String(raw || '').replace(/\D/g, '');
        if (digits.length >= 12 && digits.startsWith(ddiPadrao)) digits = digits.slice(ddiPadrao.length);
        digits = digits.replace(/^0+/, '');
        if (digits.length < 8) {
          return sendJson(res, 400, { error: 'telefone_invalido', message: `O número "${raw}" não parece válido. Confira o DDD e a quantidade de dígitos.` });
        }
        phones.push(ddiPadrao + digits);
      }

      if (phones.length < LIMITE_MINIMO_LOTE) {
        return sendJson(res, 400, {
          error: 'lote_muito_pequeno',
          message: `O lote precisa ter no mínimo ${LIMITE_MINIMO_LOTE} números (recebido: ${phones.length}).`,
          minimo: LIMITE_MINIMO_LOTE,
          recebido: phones.length,
        });
      }

      let callbackUrl = (data.callback_url !== undefined ? data.callback_url : team.webhookUrl) || null;
      if (callbackUrl && !/^https?:\/\//i.test(callbackUrl)) {
        return sendJson(res, 400, { error: 'callback_url_invalida', message: 'callback_url precisa começar com http:// ou https://.' });
      }

      const waApiKey = (await readSettings()).waApiKey;
      if (!waApiKey) return sendJson(res, 503, { error: 'servico_indisponivel', message: 'O serviço de validação em lote ainda não foi configurado. Fale com o administrador.' });

      const loteId = crypto.randomBytes(9).toString('hex');
      await pruneApiWaLotes();
      await q(
        'INSERT INTO api_wa_lotes (id, team_id, status, total, callback_url) VALUES ($1,$2,$3,$4,$5)',
        [loteId, team.id, 'processing', phones.length, callbackUrl]
      );

      // Fire-and-forget: a resposta HTTP não espera o lote inteiro terminar
      // (pode levar minutos — mesmo prazo do Formatador de base hoje).
      runApiWhatsappCheckLote(loteId, team, phones, waApiKey, callbackUrl).catch((e) =>
        console.error('[api/whatsapp/check-lote] erro inesperado no processamento em segundo plano:', e.message)
      );

      return sendJson(res, 202, { status: 'processing', lote_id: loteId, total: phones.length });
    }

    // Consulta o resultado de um lote — mesmo papel do GET /check/:id, só
    // que devolve o array inteiro de resultados quando pronto.
    const apiCheckLoteStatusMatch = pathname.match(/^\/api\/v1\/whatsapp\/check-lote\/([^/]+)$/);
    if (apiCheckLoteStatusMatch && req.method === 'GET') {
      const auth = await authenticateApiTeam(req);
      if (auth.error) return auth.error(res);
      const { team } = auth;

      const rate = checkApiPollRateLimit(team.id);
      if (!rate.ok) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        return sendJson(res, 429, { error: 'limite_excedido', message: `Limite de consultas de status atingido. Tente novamente em ${rate.retryAfterSec}s.` });
      }

      const loteId = decodeURIComponent(apiCheckLoteStatusMatch[1]);
      const { rows } = await q('SELECT * FROM api_wa_lotes WHERE id=$1 AND team_id=$2', [loteId, team.id]);
      const row = rows[0];
      if (!row) return sendJson(res, 404, { error: 'nao_encontrado', message: 'Esse lote não existe ou não pertence à sua credencial.' });

      if (row.status === 'processing') return sendJson(res, 200, { status: 'processing', lote_id: loteId, total: row.total });
      if (row.status === 'done') return sendJson(res, 200, { status: 'done', lote_id: loteId, total: row.total, resultados: row.resultados });
      return sendJson(res, 200, { status: 'error', lote_id: loteId, message: row.error_message || 'Não foi possível validar esse lote agora.' });
    }

    if (req.method === 'POST' && pathname === '/api/v1/whatsapp/check') {
      const auth = await authenticateApiTeam(req);
      if (auth.error) return auth.error(res);
      const { team } = auth;

      const rate = checkApiRateLimit(team.id);
      if (!rate.ok) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        return sendJson(res, 429, { error: 'limite_excedido', message: `Limite de ${API_RATE_LIMIT} requisições por minuto atingido. Tente novamente em ${rate.retryAfterSec}s.` });
      }

      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { error: 'json_invalido', message: 'Corpo da requisição precisa ser um JSON válido.' }); }

      const rawPhone = String(data.phone || '').replace(/\D/g, '');
      if (!rawPhone) return sendJson(res, 400, { error: 'telefone_ausente', message: 'Informe o campo "phone" (com DDD, com ou sem DDI do país).' });

      const ddiPadrao = String(data.ddi || '55').replace(/\D/g, '') || '55';
      let localPhone = rawPhone;
      if (localPhone.length >= 12 && localPhone.startsWith(ddiPadrao)) localPhone = localPhone.slice(ddiPadrao.length);
      localPhone = localPhone.replace(/^0+/, '');
      if (localPhone.length < 8) {
        return sendJson(res, 400, { error: 'telefone_invalido', message: 'Esse número não parece válido. Confira o DDD e a quantidade de dígitos.' });
      }

      let callbackUrl = (data.callback_url !== undefined ? data.callback_url : team.webhookUrl) || null;
      if (callbackUrl && !/^https?:\/\//i.test(callbackUrl)) {
        return sendJson(res, 400, { error: 'callback_url_invalida', message: 'callback_url precisa começar com http:// ou https://.' });
      }

      const ekycproApiKey = (await readSettings()).ekycproApiKey;
      if (!ekycproApiKey) return sendJson(res, 503, { error: 'servico_indisponivel', message: 'O serviço de validação ainda não foi configurado. Fale com o administrador.' });

      const fullDigits = ddiPadrao + localPhone;
      const checkId = crypto.randomBytes(9).toString('hex');
      await pruneApiWaChecks();
      await q(
        'INSERT INTO api_wa_checks (id, team_id, phone, status, callback_url) VALUES ($1,$2,$3,$4,$5)',
        [checkId, team.id, fullDigits, 'processing', callbackUrl]
      );

      // Fire-and-forget: a resposta HTTP não espera isso terminar.
      runApiWhatsappCheck(checkId, team, fullDigits, ekycproApiKey, callbackUrl).catch(e => console.error('[api/whatsapp/check] erro inesperado no processamento em segundo plano:', e.message));

      return sendJson(res, 202, { status: 'processing', request_id: checkId, phone: fullDigits });
    }

    // Consulta o resultado de uma checagem — plano B caso o webhook não tenha
    // sido configurado ou não tenha sido entregue com sucesso.
    const apiCheckStatusMatch = pathname.match(/^\/api\/v1\/whatsapp\/check\/([^/]+)$/);
    if (apiCheckStatusMatch && req.method === 'GET') {
      const auth = await authenticateApiTeam(req);
      if (auth.error) return auth.error(res);
      const { team } = auth;

      const rate = checkApiPollRateLimit(team.id);
      if (!rate.ok) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        return sendJson(res, 429, { error: 'limite_excedido', message: `Limite de consultas de status atingido. Tente novamente em ${rate.retryAfterSec}s.` });
      }

      const checkId = decodeURIComponent(apiCheckStatusMatch[1]);
      const { rows } = await q('SELECT * FROM api_wa_checks WHERE id=$1 AND team_id=$2', [checkId, team.id]);
      const row = rows[0];
      if (!row) return sendJson(res, 404, { error: 'nao_encontrado', message: 'Essa consulta não existe ou não pertence à sua credencial.' });

      if (row.status === 'processing') return sendJson(res, 200, { status: 'processing', request_id: checkId });
      if (row.status === 'done') return sendJson(res, 200, { status: 'done', request_id: checkId, phone: row.phone, has_whatsapp: row.has_whatsapp });
      return sendJson(res, 200, { status: 'error', request_id: checkId, message: row.error_message || 'Não foi possível validar esse número agora.' });
    }

    // ---- A partir daqui, exige sessão válida se LOGIN_REQUIRED ----
    const sessionUser = await getSessionUserRecord(req);
    if (LOGIN_REQUIRED && !sessionUser) {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/formatador' || pathname === '/admin' || pathname === '/historico' || pathname === '/agendamentos' || pathname === '/ajuda' || pathname === '/links' || pathname === '/consumo')) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return sendJson(res, 401, { error: 'not_authenticated' });
    }

    // ---- Painel administrativo (exige papel admin) ----
    // Obs.: POST /api/suggestions (enviar uma sugestão) fica de fora de propósito —
    // qualquer usuário logado pode enviar. Só listar (GET) e resolver são admin-only.
    const isAdminArea = pathname === '/admin' || pathname.startsWith('/api/users') ||
      pathname.startsWith('/api/teams') || pathname === '/api/adminlog' || pathname.startsWith('/api/password-resets') ||
      pathname === '/api/settings' || (pathname === '/api/suggestions' && req.method === 'GET') ||
      pathname.startsWith('/api/suggestions/') || pathname.startsWith('/api/invoices') ||
      pathname.startsWith('/api/financeiro');

    if (isAdminArea) {
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin') {
        if (req.method === 'GET' && pathname === '/admin') {
          res.writeHead(302, { Location: '/' });
          return res.end();
        }
        return sendJson(res, 403, { error: 'forbidden', message: 'Só administradores podem acessar isso.' });
      }

      if (req.method === 'GET' && pathname === '/admin') {
        return sendFile(res, ADMIN_FILE, 'text/html; charset=utf-8');
      }

      // ---- Usuários ----
      if (req.method === 'GET' && pathname === '/api/users') {
        const users = await readUsers();
        return sendJson(res, 200, await Promise.all(users.map(publicUserWithTeam)));
      }

      if (req.method === 'POST' && pathname === '/api/users') {
        const body = await readBody(req);
        let data;
        try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { error: 'json_invalido' }); }
        const { username, password, name, email, role, credits, linkCredits, teamId, logoBase64 } = data;
        if (!username || !password) return sendJson(res, 400, { message: 'Usuário e senha são obrigatórios.' });
        const existing = await findUserRecord(username);
        if (existing) return sendJson(res, 409, { message: 'Já existe um usuário com esse nome.' });

        const finalRole = role === 'admin' ? 'admin' : 'user';
        const finalCredits = (credits === null || credits === undefined || credits === '') ? null : Number(credits);
        const finalLinkCredits = (linkCredits === null || linkCredits === undefined || linkCredits === '') ? null : Number(linkCredits);
        let logoMime = null, logoData = null;
        if (logoBase64) {
          try { ({ mime: logoMime, buffer: logoData } = decodeLogoDataUrl(logoBase64)); }
          catch (e) { return sendJson(res, 400, { message: e.message }); }
        }
        await q(
          'INSERT INTO users (username, password_hash, name, email, role, credits, link_credits, team_id, active, logo_data, logo_mime) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)',
          [username, hashPassword(password), name || username, (email || '').trim() || null, finalRole, finalCredits, finalLinkCredits, teamId || null, logoData, logoMime]
        );
        await logAdminAction(sessionUser.username, 'criar_usuario', username, `papel=${finalRole}, creditos=${finalCredits ?? 'ilimitado'}, creditos_link=${finalLinkCredits ?? 'ilimitado'}`);
        const created = await findUserRecord(username);
        return sendJson(res, 200, await publicUserWithTeam(created));
      }

      const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch) {
        const targetUsername = decodeURIComponent(userMatch[1]);

        if (req.method === 'PUT') {
          const current = await findUserRecord(targetUsername);
          if (!current) return sendJson(res, 404, { error: 'nao_encontrado' });
          const body = await readBody(req);
          let data;
          try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { error: 'json_invalido' }); }

          if (current.role === 'admin' && ((data.role && data.role !== 'admin') || data.active === false)) {
            const others = await countActiveAdmins(targetUsername);
            if (others === 0) return sendJson(res, 400, { message: 'Não é possível remover ou desativar o último administrador.' });
          }

          const changes = [];
          const sets = [];
          const params = [];
          let p = 1;

          if (data.name !== undefined && data.name !== current.name) { changes.push(`nome: ${current.name} → ${data.name}`); sets.push(`name=$${p++}`); params.push(data.name); }
          if (data.email !== undefined) {
            const newEmail = (data.email || '').trim() || null;
            if (newEmail !== (current.email || null)) changes.push(`email: ${current.email || '(vazio)'} → ${newEmail || '(vazio)'}`);
            sets.push(`email=$${p++}`); params.push(newEmail);
          }
          if (data.role !== undefined) {
            const newRole = data.role === 'admin' ? 'admin' : 'user';
            if (newRole !== current.role) changes.push(`papel: ${current.role} → ${newRole}`);
            sets.push(`role=$${p++}`); params.push(newRole);
          }
          if (data.active !== undefined && !!data.active !== (current.active !== false)) {
            changes.push(data.active ? 'reativado' : 'desativado');
            sets.push(`active=$${p++}`); params.push(!!data.active);
          }
          if (data.credits !== undefined) {
            const newCredits = (data.credits === null || data.credits === '') ? null : Number(data.credits);
            if (newCredits !== current.credits) changes.push(`créditos: ${current.credits ?? 'ilimitado'} → ${newCredits ?? 'ilimitado'}`);
            sets.push(`credits=$${p++}`); params.push(newCredits);
          }
          if (data.linkCredits !== undefined) {
            const newLinkCredits = (data.linkCredits === null || data.linkCredits === '') ? null : Number(data.linkCredits);
            if (newLinkCredits !== current.linkCredits) changes.push(`créditos de link: ${current.linkCredits ?? 'ilimitado'} → ${newLinkCredits ?? 'ilimitado'}`);
            sets.push(`link_credits=$${p++}`); params.push(newLinkCredits);
          }
          if (data.teamId !== undefined) {
            const newTeamId = data.teamId || null;
            if (newTeamId !== (current.teamId || null)) changes.push(`time: ${current.teamId || 'nenhum'} → ${newTeamId || 'nenhum'}`);
            sets.push(`team_id=$${p++}`); params.push(newTeamId);
          }
          if (data.password) { sets.push(`password_hash=$${p++}`); params.push(hashPassword(data.password)); changes.push('senha redefinida'); }
          if (data.logoBase64) {
            let decoded;
            try { decoded = decodeLogoDataUrl(data.logoBase64); }
            catch (e) { return sendJson(res, 400, { message: e.message }); }
            changes.push('logo atualizada');
            sets.push(`logo_data=$${p++}`); params.push(decoded.buffer);
            sets.push(`logo_mime=$${p++}`); params.push(decoded.mime);
          } else if (data.removeLogo) {
            changes.push('logo removida');
            sets.push(`logo_data=$${p++}`); params.push(null);
            sets.push(`logo_mime=$${p++}`); params.push(null);
          }

          if (sets.length) {
            params.push(targetUsername);
            await q(`UPDATE users SET ${sets.join(', ')} WHERE username=$${p}`, params);
          }
          if (changes.length) await logAdminAction(sessionUser.username, 'editar_usuario', targetUsername, changes.join('; '));
          const updated = await findUserRecord(targetUsername);
          return sendJson(res, 200, await publicUserWithTeam(updated));
        }

        if (req.method === 'DELETE') {
          const current = await findUserRecord(targetUsername);
          if (!current) return sendJson(res, 404, { error: 'nao_encontrado' });
          if (current.role === 'admin') {
            const others = await countActiveAdmins(targetUsername);
            if (others === 0) return sendJson(res, 400, { message: 'Não é possível remover o último administrador.' });
          }
          await q('DELETE FROM users WHERE username=$1', [targetUsername]);
          await logAdminAction(sessionUser.username, 'remover_usuario', targetUsername, '');
          return sendJson(res, 200, { ok: true });
        }
      }

      // Gera e aplica uma senha temporária diretamente
      const genPwMatch = pathname.match(/^\/api\/users\/([^/]+)\/generate-password$/);
      if (genPwMatch && req.method === 'POST') {
        const targetUsername = decodeURIComponent(genPwMatch[1]);
        const current = await findUserRecord(targetUsername);
        if (!current) return sendJson(res, 404, { error: 'nao_encontrado' });
        const tempPassword = randomTempPassword();
        await q('UPDATE users SET password_hash=$1 WHERE username=$2', [hashPassword(tempPassword), targetUsername]);
        await logAdminAction(sessionUser.username, 'gerar_senha_temporaria', targetUsername, 'senha temporária gerada pelo painel de usuários');
        return sendJson(res, 200, { ok: true, tempPassword });
      }

      // ---- Times ----
      if (req.method === 'GET' && pathname === '/api/teams') {
        return sendJson(res, 200, await readTeams());
      }

      if (req.method === 'POST' && pathname === '/api/teams') {
        const body = await readBody(req);
        let data;
        try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { error: 'json_invalido' }); }
        if (!data.name) return sendJson(res, 400, { message: 'Nome do time é obrigatório.' });
        const billingType = data.billingType === 'pospago' ? 'pospago' : 'prepago';
        if (billingType === 'pospago' && (!data.billingCycleDays || Number(data.billingCycleDays) < 1)) {
          return sendJson(res, 400, { message: 'Informe a cada quantos dias o ciclo do time pós-pago fecha.' });
        }
        const id = crypto.randomBytes(6).toString('hex');
        const credits = (data.credits === null || data.credits === undefined || data.credits === '') ? null : Number(data.credits);
        const linkCredits = (data.linkCredits === null || data.linkCredits === undefined || data.linkCredits === '') ? null : Number(data.linkCredits);
        const priceBase = (data.pricePerCreditBase === null || data.pricePerCreditBase === undefined || data.pricePerCreditBase === '') ? null : Number(data.pricePerCreditBase);
        const priceLink = (data.pricePerCreditLink === null || data.pricePerCreditLink === undefined || data.pricePerCreditLink === '') ? null : Number(data.pricePerCreditLink);
        const cycleDays = billingType === 'pospago' ? Number(data.billingCycleDays) : null;
        const cycleStart = billingType === 'pospago' ? new Date() : null;
        // Dados de faturamento do cliente/time — opcionais, valem pros dois
        // tipos de cobrança (só aparecem na fatura em PDF de quem é pós-pago).
        const cnpj = (data.cnpj || '').trim() || null;
        const responsavelNome = (data.responsavelNome || '').trim() || null;
        const responsavelEmail = (data.responsavelEmail || '').trim() || null;
        await q(
          `INSERT INTO teams (id, name, credits, link_credits, billing_type, price_per_credit_base, price_per_credit_link, billing_cycle_days, cycle_start, cnpj, responsavel_nome, responsavel_email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, data.name, credits, linkCredits, billingType, priceBase, priceLink, cycleDays, cycleStart, cnpj, responsavelNome, responsavelEmail]
        );
        const detail = billingType === 'pospago'
          ? `pós-pago, R$${priceBase ?? 0}/crédito base, R$${priceLink ?? 0}/crédito link, ciclo de ${cycleDays} dia(s)`
          : `pré-pago, creditos=${credits ?? 'ilimitado'}, creditos_link=${linkCredits ?? 'ilimitado'}`;
        await logAdminAction(sessionUser.username, 'criar_time', data.name, detail);
        return sendJson(res, 200, await findTeam(id));
      }

      const teamMatch = pathname.match(/^\/api\/teams\/([^/]+)$/);
      if (teamMatch) {
        const teamId = decodeURIComponent(teamMatch[1]);

        if (req.method === 'PUT') {
          const current = await findTeam(teamId);
          if (!current) return sendJson(res, 404, { error: 'nao_encontrado' });
          const body = await readBody(req);
          let data;
          try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { error: 'json_invalido' }); }
          const changes = [];
          const sets = []; const params = []; let p = 1;
          if (data.name !== undefined && data.name !== current.name) { changes.push(`nome: ${current.name} → ${data.name}`); sets.push(`name=$${p++}`); params.push(data.name); }
          if (data.credits !== undefined) {
            const newCredits = (data.credits === null || data.credits === '') ? null : Number(data.credits);
            if (newCredits !== current.credits) changes.push(`créditos: ${current.credits ?? 'ilimitado'} → ${newCredits ?? 'ilimitado'}`);
            sets.push(`credits=$${p++}`); params.push(newCredits);
          }
          if (data.linkCredits !== undefined) {
            const newLinkCredits = (data.linkCredits === null || data.linkCredits === '') ? null : Number(data.linkCredits);
            if (newLinkCredits !== current.linkCredits) changes.push(`créditos de link: ${current.linkCredits ?? 'ilimitado'} → ${newLinkCredits ?? 'ilimitado'}`);
            sets.push(`link_credits=$${p++}`); params.push(newLinkCredits);
          }

          // ---- Módulo financeiro: tipo de cobrança, preços e ciclo ----
          let newBillingType = current.billingType;
          if (data.billingType !== undefined) {
            newBillingType = data.billingType === 'pospago' ? 'pospago' : 'prepago';
            if (newBillingType === 'pospago' && current.billingType !== 'pospago' && (!data.billingCycleDays || Number(data.billingCycleDays) < 1)) {
              return sendJson(res, 400, { message: 'Informe a cada quantos dias o ciclo do time pós-pago fecha.' });
            }
          }
          if (newBillingType !== current.billingType) {
            changes.push(`cobrança: ${current.billingType === 'pospago' ? 'pós-pago' : 'pré-pago'} → ${newBillingType === 'pospago' ? 'pós-pago' : 'pré-pago'}`);
            // Saindo do pós-pago: fecha o ciclo em aberto (mesmo que parcial)
            // antes de trocar, pra não perder o uso já registrado sem cobrar.
            if (current.billingType === 'pospago' && newBillingType !== 'pospago' && current.cycleStart) {
              try { await closeBillingCycle(current, new Date()); }
              catch (e) { console.error('Erro ao fechar ciclo financeiro na troca de cobrança:', e.message); }
            }
            sets.push(`billing_type=$${p++}`); params.push(newBillingType);
            // Entrando no pós-pago agora: começa um ciclo novo a partir de hoje.
            if (newBillingType === 'pospago' && current.billingType !== 'pospago') {
              sets.push(`cycle_start=$${p++}`); params.push(new Date());
            }
          }
          if (data.pricePerCreditBase !== undefined) {
            const newPrice = (data.pricePerCreditBase === null || data.pricePerCreditBase === '') ? null : Number(data.pricePerCreditBase);
            if (newPrice !== current.pricePerCreditBase) changes.push(`preço/crédito base: ${current.pricePerCreditBase ?? '—'} → ${newPrice ?? '—'}`);
            sets.push(`price_per_credit_base=$${p++}`); params.push(newPrice);
          }
          if (data.pricePerCreditLink !== undefined) {
            const newPrice = (data.pricePerCreditLink === null || data.pricePerCreditLink === '') ? null : Number(data.pricePerCreditLink);
            if (newPrice !== current.pricePerCreditLink) changes.push(`preço/crédito link: ${current.pricePerCreditLink ?? '—'} → ${newPrice ?? '—'}`);
            sets.push(`price_per_credit_link=$${p++}`); params.push(newPrice);
          }
          if (data.billingCycleDays !== undefined) {
            const newCycleDays = (data.billingCycleDays === null || data.billingCycleDays === '') ? null : Number(data.billingCycleDays);
            if (newCycleDays !== current.billingCycleDays) changes.push(`ciclo: ${current.billingCycleDays ?? '—'} → ${newCycleDays ?? '—'} dia(s)`);
            sets.push(`billing_cycle_days=$${p++}`); params.push(newCycleDays);
          }

          // ---- Dados de faturamento do cliente/time (opcionais, pré ou pós-pago) ----
          if (data.cnpj !== undefined) {
            const newCnpj = (data.cnpj || '').trim() || null;
            if (newCnpj !== (current.cnpj || null)) changes.push(`CNPJ: ${current.cnpj || '—'} → ${newCnpj || '—'}`);
            sets.push(`cnpj=$${p++}`); params.push(newCnpj);
          }
          if (data.responsavelNome !== undefined) {
            const newVal = (data.responsavelNome || '').trim() || null;
            if (newVal !== (current.responsavelNome || null)) changes.push(`responsável: ${current.responsavelNome || '—'} → ${newVal || '—'}`);
            sets.push(`responsavel_nome=$${p++}`); params.push(newVal);
          }
          if (data.responsavelEmail !== undefined) {
            const newVal = (data.responsavelEmail || '').trim() || null;
            if (newVal !== (current.responsavelEmail || null)) changes.push(`e-mail financeiro: ${current.responsavelEmail || '—'} → ${newVal || '—'}`);
            sets.push(`responsavel_email=$${p++}`); params.push(newVal);
          }
          if (data.webhookUrl !== undefined) {
            const newVal = (data.webhookUrl || '').trim() || null;
            if (newVal && !/^https?:\/\//i.test(newVal)) return sendJson(res, 400, { message: 'A URL do webhook precisa começar com http:// ou https://.' });
            if (newVal !== (current.webhookUrl || null)) changes.push(`webhook: ${current.webhookUrl || '—'} → ${newVal || '—'}`);
            sets.push(`webhook_url=$${p++}`); params.push(newVal);
          }

          if (sets.length) { params.push(teamId); await q(`UPDATE teams SET ${sets.join(', ')} WHERE id=$${p}`, params); }
          if (changes.length) await logAdminAction(sessionUser.username, 'editar_time', current.name, changes.join('; '));
          return sendJson(res, 200, await findTeam(teamId));
        }

        if (req.method === 'DELETE') {
          const current = await findTeam(teamId);
          if (!current) return sendJson(res, 404, { error: 'nao_encontrado' });
          await q('UPDATE users SET team_id=NULL WHERE team_id=$1', [teamId]);
          await q('DELETE FROM teams WHERE id=$1', [teamId]);
          await logAdminAction(sessionUser.username, 'remover_time', current.name, '');
          return sendJson(res, 200, { ok: true });
        }
      }

      // ---- Credencial de API (consulta avulsa de WhatsApp) ----
      // Só times pós-pagos podem ter chave — a API consome o mesmo saldo/preço
      // de sempre, e só faz sentido pro modelo de uso ilimitado + fatura.
      const apiKeyMatch = pathname.match(/^\/api\/teams\/([^/]+)\/api-key$/);
      if (apiKeyMatch && req.method === 'POST') {
        const teamId = decodeURIComponent(apiKeyMatch[1]);
        const team = await findTeam(teamId);
        if (!team) return sendJson(res, 404, { error: 'nao_encontrado' });
        if (team.billingType !== 'pospago') {
          return sendJson(res, 400, { message: 'Só times pós-pagos podem ter credencial de API. Mude o tipo de cobrança do time primeiro.' });
        }
        const plainKey = generateApiKeyPlaintext();
        const prefix = plainKey.slice(0, 13) + '…';
        await q('UPDATE teams SET api_key_hash=$1, api_key_prefix=$2, api_key_created_at=now() WHERE id=$3', [hashApiKey(plainKey), prefix, teamId]);
        await logAdminAction(sessionUser.username, team.hasApiKey ? 'regenerar_api_key' : 'gerar_api_key', team.name, `prefixo ${prefix}`);
        // A chave em texto puro só existe agora — não fica salva em lugar
        // nenhum, nem pra nós. Se perder, só gerando outra.
        return sendJson(res, 200, { ok: true, apiKey: plainKey, team: await findTeam(teamId) });
      }
      if (apiKeyMatch && req.method === 'DELETE') {
        const teamId = decodeURIComponent(apiKeyMatch[1]);
        const team = await findTeam(teamId);
        if (!team) return sendJson(res, 404, { error: 'nao_encontrado' });
        await q('UPDATE teams SET api_key_hash=NULL, api_key_prefix=NULL, api_key_created_at=NULL WHERE id=$1', [teamId]);
        await logAdminAction(sessionUser.username, 'revogar_api_key', team.name, '');
        return sendJson(res, 200, { ok: true, team: await findTeam(teamId) });
      }

      // ---- Módulo financeiro: faturas dos times pós-pagos ----
      if (req.method === 'GET' && pathname === '/api/invoices') {
        const { rows } = await q('SELECT * FROM invoices ORDER BY generated_at DESC LIMIT 500');
        return sendJson(res, 200, rows.map(rowToInvoice));
      }

      const invoicePdfMatch = pathname.match(/^\/api\/invoices\/([^/]+)\/pdf$/);
      if (invoicePdfMatch && req.method === 'GET') {
        const invoiceId = Number(decodeURIComponent(invoicePdfMatch[1]));
        const { rows } = await q('SELECT pdf_data, team_name, period_start FROM invoices WHERE id=$1', [invoiceId]);
        const row = rows[0];
        if (!row || !row.pdf_data) return sendJson(res, 404, { error: 'nao_encontrado' });
        const period = new Date(row.period_start).toISOString().slice(0, 10);
        const safeTeam = (row.team_name || 'time').replace(/[^a-zA-Z0-9-_]+/g, '_');
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="fatura_${safeTeam}_${period}.pdf"`,
        });
        return res.end(row.pdf_data);
      }

      const invoiceMarkPaidMatch = pathname.match(/^\/api\/invoices\/([^/]+)\/mark-paid$/);
      if (invoiceMarkPaidMatch && req.method === 'POST') {
        const invoiceId = Number(decodeURIComponent(invoiceMarkPaidMatch[1]));
        const { rows } = await q('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
        const invoice = rowToInvoice(rows[0]);
        if (!invoice) return sendJson(res, 404, { error: 'nao_encontrado' });
        if (invoice.status !== 'pago') {
          await q(`UPDATE invoices SET status='pago', paid_at=now() WHERE id=$1`, [invoiceId]);
          await logAdminAction(sessionUser.username, 'marcar_fatura_paga', invoice.teamName || '', `fatura #${invoiceId} — ${brl(invoice.amountTotal)}`);
        }
        return sendJson(res, 200, await q('SELECT * FROM invoices WHERE id=$1', [invoiceId]).then(r => rowToInvoice(r.rows[0])));
      }

      // Diagnóstico: mostra CADA linha do livro-razão (credit_usage_log) de um
      // time pós-pago, dentro do ciclo atual — pra investigar quando o total
      // parecer errado, sem precisar de acesso a terminal/banco. Só leitura.
      const consumoDetalhadoMatch = pathname.match(/^\/api\/teams\/([^/]+)\/consumo-detalhado$/);
      if (consumoDetalhadoMatch && req.method === 'GET') {
        const teamId = decodeURIComponent(consumoDetalhadoMatch[1]);
        const team = await findTeam(teamId);
        if (!team) return sendJson(res, 404, { error: 'nao_encontrado' });
        const periodStart = team.cycleStart || new Date(0);
        const { rows } = await q(
          `SELECT credit_type, source, quantity, unit_price, amount, file_name, created_at
           FROM credit_usage_log
           WHERE team_id=$1 AND created_at >= $2
           ORDER BY created_at ASC`,
          [team.id, periodStart]
        );
        const totalQuantity = rows.filter(r => r.credit_type === 'base').reduce((s, r) => s + Number(r.quantity), 0);
        const totalAmount = rows.filter(r => r.credit_type === 'base').reduce((s, r) => s + Number(r.amount), 0);
        return sendJson(res, 200, {
          teamName: team.name, cycleStart: team.cycleStart, totalLinhas: rows.length,
          totalQuantity, totalAmount, linhas: rows,
        });
      }

      // Fecha manualmente o ciclo em aberto de um time pós-pago agora mesmo,
      // sem esperar a data — útil pra gerar a primeira fatura de teste ou
      // adiantar um fechamento.
      const invoiceCloseNowMatch = pathname.match(/^\/api\/teams\/([^/]+)\/close-cycle-now$/);
      if (invoiceCloseNowMatch && req.method === 'POST') {
        const teamId = decodeURIComponent(invoiceCloseNowMatch[1]);
        const team = await findTeam(teamId);
        if (!team) return sendJson(res, 404, { error: 'nao_encontrado' });
        if (team.billingType !== 'pospago' || !team.cycleStart) {
          return sendJson(res, 400, { message: 'Esse time não é pós-pago ou ainda não tem ciclo em andamento.' });
        }
        const invoice = await closeBillingCycle(team, new Date());
        await logAdminAction(sessionUser.username, 'fechar_ciclo_manual', team.name, `fatura #${invoice.id} — ${brl(invoice.amountTotal)}`);
        return sendJson(res, 200, invoice);
      }

      // Estimativa do que já está "acumulando" nos ciclos em aberto de TODOS
      // os times pós-pagos, sem fechar nada — pedido explícito do cliente
      // pra ter noção do valor a receber mesmo sem forçar o fechamento do
      // ciclo.
      //
      // IMPORTANTE: conta a partir da tabela "history" (a mesma que alimenta
      // a aba Histórico — Arquivos e API), não do livro-razão
      // (credit_usage_log). Pedido explícito: o Financeiro tem que bater
      // exatamente com o que aparece no Histórico, nem um contato a mais.
      // Se uma consulta ao livro-razão não tem uma linha correspondente no
      // Histórico, ela não deve contar aqui.
      //
      // Usa "total" (contatos processados), não "valid" (prontos pra
      // disparo) — pedido explícito: o custo existe em processar o contato,
      // tenha WhatsApp ou não. "Válidos" só filtra quem tem WhatsApp, não
      // representa o volume real que gerou custo.
      if (req.method === 'GET' && pathname === '/api/financeiro/estimativa') {
        const { rows: teamsRows } = await q(
          `SELECT * FROM teams WHERE billing_type='pospago' AND cycle_start IS NOT NULL`
        );
        let totalEstimado = 0;
        const porTime = [];
        for (const row of teamsRows) {
          const team = rowToTeam(row);
          const { rows } = await q(
            `SELECT
               COALESCE(SUM(total) FILTER (WHERE platform <> 'api'), 0) AS qty_sistema,
               COALESCE(SUM(total) FILTER (WHERE platform = 'api'), 0) AS qty_api
             FROM history
             WHERE team_id=$1 AND ts >= $2 AND ts < now()`,
            [team.id, team.cycleStart]
          );
          const qtySistema = Number(rows[0].qty_sistema) || 0;
          const qtyApi = Number(rows[0].qty_api) || 0;
          const precoBase = team.pricePerCreditBase != null ? Number(team.pricePerCreditBase) : 0;
          const amount = (qtySistema + qtyApi) * precoBase;
          totalEstimado += amount;
          if (amount > 0 || qtySistema > 0 || qtyApi > 0) {
            porTime.push({
              teamId: team.id, teamName: team.name, amount, cycleStart: team.cycleStart,
              qtySistema, qtyApi, qtyTotal: qtySistema + qtyApi,
            });
          }
        }
        return sendJson(res, 200, { totalEstimado, porTime });
      }

      // ---- Log de ações administrativas ----
      if (req.method === 'GET' && pathname === '/api/adminlog') {
        return sendJson(res, 200, await readAdminLog());
      }

      // ---- Solicitações de redefinição de senha ----
      if (req.method === 'GET' && pathname === '/api/password-resets') {
        return sendJson(res, 200, await readResets());
      }

      const resetMatch = pathname.match(/^\/api\/password-resets\/([^/]+)\/resolve$/);
      if (resetMatch && req.method === 'POST') {
        const resetId = decodeURIComponent(resetMatch[1]);
        const { rows } = await q('SELECT * FROM password_resets WHERE id=$1', [resetId]);
        const reset = rows[0];
        if (!reset) return sendJson(res, 404, { error: 'nao_encontrado' });
        const user = await findUserRecord(reset.username);
        if (!user) return sendJson(res, 404, { error: 'usuario_nao_encontrado' });

        const tempPassword = randomTempPassword();
        await q('UPDATE users SET password_hash=$1 WHERE username=$2', [hashPassword(tempPassword), reset.username]);
        await q(`UPDATE password_resets SET status='resolved', resolved_at=now(), resolved_by=$1 WHERE id=$2`, [sessionUser.username, resetId]);
        await logAdminAction(sessionUser.username, 'redefinir_senha', reset.username, 'via solicitação de esqueci-minha-senha');
        return sendJson(res, 200, { ok: true, tempPassword });
      }

      // ---- Sugestões (listar e resolver — só admin; enviar é rota separada, aberta a qualquer usuário) ----
      if (req.method === 'GET' && pathname === '/api/suggestions') {
        const { rows } = await q('SELECT * FROM suggestions ORDER BY created_at DESC');
        const avatarMap = await getUserAvatarMap();
        return sendJson(res, 200, rows.map(r => ({
          id: r.id, username: r.username, name: r.name, message: r.message,
          ts: r.created_at, resolved: r.resolved,
          logoUrl: (avatarMap[r.username] && avatarMap[r.username].logoUrl) || null,
        })));
      }

      const suggestionResolveMatch = pathname.match(/^\/api\/suggestions\/([^/]+)\/resolve$/);
      if (suggestionResolveMatch && req.method === 'POST') {
        const suggestionId = decodeURIComponent(suggestionResolveMatch[1]);
        await q(
          `UPDATE suggestions SET resolved=true, resolved_at=now(), resolved_by=$1 WHERE id=$2`,
          [sessionUser.username, suggestionId]
        );
        return sendJson(res, 200, { ok: true });
      }

      // ---- Configurações do sistema (API key do validador) ----
      if (req.method === 'GET' && pathname === '/api/settings') {
        return sendJson(res, 200, await readSettings());
      }

      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = await readBody(req);
        let data;
        try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { error: 'json_invalido' }); }
        await writeSettings(data);
        await logAdminAction(sessionUser.username, 'atualizar_configuracoes', 'sistema', 'configurações do sistema atualizadas');
        return sendJson(res, 200, { ok: true });
      }
    }

    // Serve o painel (dashboard) — agora é a tela inicial do sistema
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return sendFile(res, DASHBOARD_FILE, 'text/html; charset=utf-8');
    }

    // Serve a ferramenta de formatação de base (agora um módulo, não mais a tela inicial)
    if (req.method === 'GET' && pathname === '/formatador') {
      return sendFile(res, HTML_FILE, 'text/html; charset=utf-8');
    }

    // Serve o dashboard de histórico
    if (req.method === 'GET' && pathname === '/historico') {
      return sendFile(res, HISTORICO_FILE, 'text/html; charset=utf-8');
    }

    // Serve a página de agendamentos
    if (req.method === 'GET' && pathname === '/agendamentos') {
      return sendFile(res, AGENDA_FILE, 'text/html; charset=utf-8');
    }

    // Serve a página "Meu consumo" (só faz sentido pra times pós-pagos, mas o
    // arquivo é servido igual pra qualquer usuário logado — o conteúdo em si
    // já checa elegibilidade via /api/meu-consumo e mostra uma mensagem
    // simples se não se aplicar).
    if (req.method === 'GET' && pathname === '/consumo') {
      return sendFile(res, CONSUMO_FILE, 'text/html; charset=utf-8');
    }

    // Serve a página de ajuda ("Como usar")
    if (req.method === 'GET' && pathname === '/ajuda') {
      return sendFile(res, AJUDA_FILE, 'text/html; charset=utf-8');
    }

    // Serve a página de Links (módulo separado, encurtador + estatísticas via Short.io)
    if (req.method === 'GET' && pathname === '/links') {
      return sendFile(res, LINKS_FILE, 'text/html; charset=utf-8');
    }

    // Links: criar (chama a Short.io do lado do servidor — a chave nunca vai pro navegador)
    if (req.method === 'POST' && pathname === '/api/short-links') {
      const settings = await readSettings();
      if (!settings.shortioApiKey) {
        return sendJson(res, 400, { message: 'A chave da Short.io ainda não foi configurada em /admin → Configurações.' });
      }
      if (!settings.shortioDomain) {
        return sendJson(res, 400, { message: 'O domínio da Short.io ainda não foi configurado em /admin → Configurações.' });
      }
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { message: 'JSON inválido.' }); }
      if (!data.originalUrl) return sendJson(res, 400, { message: 'Informe a URL original.' });

      const linkCredCheck = await checkLinkCreditsSufficient(sessionUser, 1);
      if (LOGIN_REQUIRED && !linkCredCheck.ok) {
        return sendJson(res, 402, { message: linkCredCheck.message });
      }

      const payload = {
        originalURL: data.originalUrl,
        domain: settings.shortioDomain,
        allowDuplicates: true,
      };
      if (data.path) payload.path = data.path;
      if (data.title) payload.title = data.title;

      let shortioResp, shortioBody;
      try {
        shortioResp = await fetch('https://api.short.io/links', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Authorization': settings.shortioApiKey },
          body: JSON.stringify(payload),
        });
        shortioBody = await shortioResp.json();
      } catch (e) {
        return sendJson(res, 502, { message: 'Falha ao falar com a Short.io: ' + e.message });
      }
      if (!shortioResp.ok) {
        return sendJson(res, shortioResp.status, { message: shortioBody.error || shortioBody.message || 'A Short.io recusou a requisição.' });
      }

      if (LOGIN_REQUIRED) {
        await deductLinkCreditsFor(linkCredCheck.creditSource, linkCredCheck.team, sessionUser.username, 1);
      }

      const id = crypto.randomBytes(8).toString('hex');
      await q(
        `INSERT INTO short_links (id, username, owner_name, shortio_link_id, original_url, short_url, path, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, sessionUser.username, sessionUser.name, shortioBody.idString || shortioBody.id || '', data.originalUrl, shortioBody.shortURL || shortioBody.secureShortURL || '', shortioBody.path || '', data.title || '']
      );
      const { rows } = await q('SELECT * FROM short_links WHERE id=$1', [id]);
      const r = rows[0];
      return sendJson(res, 200, {
        id: r.id, username: r.username, ownerName: r.owner_name, shortioLinkId: r.shortio_link_id,
        originalUrl: r.original_url, shortUrl: r.short_url, path: r.path, title: r.title, createdAt: r.created_at,
      });
    }

    // Links: listar (usuário comum só vê os seus; admin vê todos)
    if (req.method === 'GET' && pathname === '/api/short-links') {
      const rows = LOGIN_REQUIRED && sessionUser.role !== 'admin'
        ? (await q('SELECT * FROM short_links WHERE username=$1 ORDER BY created_at DESC', [sessionUser.username])).rows
        : (await q('SELECT * FROM short_links ORDER BY created_at DESC')).rows;
      return sendJson(res, 200, rows.map(r => ({
        id: r.id, username: r.username, ownerName: r.owner_name, shortioLinkId: r.shortio_link_id,
        originalUrl: r.original_url, shortUrl: r.short_url, path: r.path, title: r.title, createdAt: r.created_at,
      })));
    }

    // Links: remover (local + na própria Short.io)
    const linkDelMatch = pathname.match(/^\/api\/short-links\/([^/]+)$/);
    if (linkDelMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(linkDelMatch[1]);
      const { rows } = await q('SELECT * FROM short_links WHERE id=$1', [id]);
      const current = rows[0];
      if (!current) return sendJson(res, 404, { message: 'Link não encontrado.' });
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin' && current.username !== sessionUser.username) {
        return sendJson(res, 403, { message: 'Esse link não é seu.' });
      }
      const settings = await readSettings();
      if (settings.shortioApiKey && current.shortio_link_id) {
        try {
          await fetch(`https://api.short.io/links/${current.shortio_link_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': settings.shortioApiKey },
          });
        } catch (e) { /* remove localmente mesmo se a chamada na Short.io falhar */ }
      }
      await q('DELETE FROM short_links WHERE id=$1', [id]);
      return sendJson(res, 200, { ok: true });
    }

    // Links: estatísticas de um link específico (proxy pra Short.io, esconde a chave)
    const linkStatsMatch = pathname.match(/^\/api\/short-links\/([^/]+)\/stats$/);
    if (linkStatsMatch && req.method === 'GET') {
      const id = decodeURIComponent(linkStatsMatch[1]);
      const { rows } = await q('SELECT * FROM short_links WHERE id=$1', [id]);
      const current = rows[0];
      if (!current) return sendJson(res, 404, { message: 'Link não encontrado.' });
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin' && current.username !== sessionUser.username) {
        return sendJson(res, 403, { message: 'Esse link não é seu.' });
      }
      const settings = await readSettings();
      if (!settings.shortioApiKey) return sendJson(res, 400, { message: 'A chave da Short.io ainda não foi configurada.' });

      const period = url.searchParams.get('period') || 'last30';
      const validIntervals = ['hour', 'day', 'week', 'month'];
      const rawInterval = url.searchParams.get('interval') || 'day';
      const clicksChartInterval = validIntervals.includes(rawInterval) ? rawInterval : 'day';
      let statsResp, statsBody;
      try {
        statsResp = await fetch(`https://statistics.short.io/statistics/link/${current.shortio_link_id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Authorization': settings.shortioApiKey },
          body: JSON.stringify({ period, clicksChartInterval }),
        });
        statsBody = await statsResp.json();
      } catch (e) {
        return sendJson(res, 502, { message: 'Falha ao falar com a Short.io: ' + e.message });
      }
      if (!statsResp.ok) {
        return sendJson(res, statsResp.status, { message: statsBody.error || statsBody.message || 'A Short.io recusou a requisição de estatísticas.' });
      }
      return sendJson(res, 200, statsBody);
    }

    // Agendamentos: criar
    if (req.method === 'POST' && pathname === '/api/scheduled') {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body.toString('utf-8')); } catch (e) { return sendJson(res, 400, { error: 'json_invalido' }); }

      if (!data.fileBase64 || !data.filename) return sendJson(res, 400, { message: 'Arquivo obrigatório.' });
      if (!data.scheduledAt) return sendJson(res, 400, { message: 'Data/hora do agendamento obrigatória.' });
      const scheduledDate = new Date(data.scheduledAt);
      if (isNaN(scheduledDate.getTime())) return sendJson(res, 400, { message: 'Data/hora inválida.' });

      const id = crypto.randomBytes(8).toString('hex');
      const ext = (path.extname(data.filename) || '.xlsx').toLowerCase();
      const uploadBuffer = Buffer.from(data.fileBase64, 'base64');

      await q(
        `INSERT INTO scheduled_jobs (id, username, name, cliente, filename, upload_data, upload_ext, platform, ddi_padrao, hsm_groups, split_parts, variables, scheduled_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'agendado')`,
        [id, sessionUser.username, sessionUser.name, data.cliente || '', data.filename, uploadBuffer, ext,
         data.platform === 'hyperflow' ? 'hyperflow' : 'wati', data.ddiPadrao || '55',
         parseInt(data.hsmGroups, 10) || 1, parseInt(data.splitParts, 10) || 1,
         JSON.stringify(Array.isArray(data.variables) ? data.variables : []), scheduledDate.toISOString()]
      );
      const created = rowToJob((await findScheduledJobFull(id)));
      return sendJson(res, 200, created);
    }

    // Agendamentos: listar
    if (req.method === 'GET' && pathname === '/api/scheduled') {
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin') {
        return sendJson(res, 200, await readScheduledJobs(sessionUser.username));
      }
      return sendJson(res, 200, await readScheduledJobs());
    }

    // Agendamentos: baixar resultado
    const dlMatch = pathname.match(/^\/api\/scheduled\/([^/]+)\/download$/);
    if (dlMatch && req.method === 'GET') {
      const jobRow = await findScheduledJobFull(decodeURIComponent(dlMatch[1]));
      if (!jobRow) return sendJson(res, 404, { message: 'Agendamento não encontrado.' });
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin' && jobRow.username !== sessionUser.username) {
        return sendJson(res, 403, { message: 'Esse agendamento não é seu.' });
      }
      if (jobRow.status !== 'concluido' || !jobRow.result_data) {
        return sendJson(res, 400, { message: 'Esse agendamento ainda não tem um resultado pronto.' });
      }
      return sendBuffer(res, jobRow.result_data, jobRow.content_type || 'application/octet-stream');
    }

    // Agendamentos: cancelar/remover
    const jobMatch = pathname.match(/^\/api\/scheduled\/([^/]+)$/);
    if (jobMatch && req.method === 'DELETE') {
      const jobRow = await findScheduledJobFull(decodeURIComponent(jobMatch[1]));
      if (!jobRow) return sendJson(res, 404, { message: 'Agendamento não encontrado.' });
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin' && jobRow.username !== sessionUser.username) {
        return sendJson(res, 403, { message: 'Esse agendamento não é seu.' });
      }
      if (jobRow.status === 'processando') {
        return sendJson(res, 400, { message: 'Esse agendamento está processando agora — espere terminar antes de remover.' });
      }
      await q('DELETE FROM scheduled_jobs WHERE id=$1', [jobRow.id]);
      return sendJson(res, 200, { ok: true });
    }

    // Quem está logado
    if (req.method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, await publicUserWithTeam(sessionUser));
    }

    // "Meu consumo" — só existe (e só faz sentido) pra times pós-pagos. Fica
    // deliberadamente fora do painel principal e da barra lateral em destaque
    // (pedido explícito: mostrar sem "assustar" o cliente com um número toda
    // vez que ele abre o sistema — quem quiser ver, procura essa página).
    // Reaproveita a mesma janela de tempo (cycleStart até agora) e a mesma
    // fonte de dados (credit_usage_log) que a fatura usa no fechamento do
    // ciclo — só que sem fechar nada, é uma leitura, pode ser aberta a
    // qualquer momento sem side-effect nenhum.
    if (req.method === 'GET' && pathname === '/api/meu-consumo') {
      if (!sessionUser.teamId) return sendJson(res, 200, { eligivel: false });
      const team = await findTeam(sessionUser.teamId);
      if (!team || team.billingType !== 'pospago') return sendJson(res, 200, { eligivel: false });

      const periodStart = team.cycleStart || new Date();
      const periodEnd = new Date();
      const { rows } = await q(
        `SELECT credit_type, source, COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(amount),0) AS amount
         FROM credit_usage_log WHERE team_id=$1 AND created_at >= $2 AND created_at < $3
         GROUP BY credit_type, source`,
        [team.id, periodStart, periodEnd]
      );
      let baseSistemaQty = 0, baseApiQty = 0, baseAmount = 0, linkQty = 0;
      rows.forEach(r => {
        const qty = Number(r.qty), amount = Number(r.amount);
        if (r.credit_type === 'base') {
          baseAmount += amount;
          if (r.source === 'api') baseApiQty += qty; else baseSistemaQty += qty;
        } else if (r.credit_type === 'link') {
          linkQty += qty;
        }
      });

      return sendJson(res, 200, {
        eligivel: true,
        teamName: team.name,
        cicloInicio: periodStart,
        cicloDias: team.billingCycleDays || null,
        precoUnitario: team.pricePerCreditBase === null ? null : Number(team.pricePerCreditBase),
        formatadorConsultas: baseSistemaQty,
        apiConsultas: baseApiQty,
        totalConsultas: baseSistemaQty + baseApiQty,
        valorEstimado: baseAmount,
        linksGerados: linkQty,
      });
    }

    // Logo do cliente/parceiro (avatar) — de propósito FORA do isAdminArea:
    // qualquer usuário logado precisa conseguir carregar a própria logo (e a
    // dos outros, quando aparece em Histórico/Painel), não só admins.
    const userLogoMatch = pathname.match(/^\/api\/user-logo\/([^/]+)$/);
    if (userLogoMatch && req.method === 'GET') {
      const targetUsername = decodeURIComponent(userLogoMatch[1]);
      const { rows } = await q('SELECT logo_data, logo_mime FROM users WHERE username=$1', [targetUsername]);
      const row = rows[0];
      if (!row || !row.logo_data) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Sem logo cadastrada.');
      }
      res.writeHead(200, { 'content-type': row.logo_mime || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(row.logo_data);
    }

    // Histórico: listar
    if (req.method === 'GET' && pathname === '/api/history') {
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin') {
        return sendJson(res, 200, await readHistory(sessionUser.username));
      }
      return sendJson(res, 200, await readHistory());
    }

    // Histórico: apagar todos os registros de um usuário (somente admin) —
    // usa query string (?user=) porque não tem um único id envolvido.
    if (req.method === 'DELETE' && pathname === '/api/history') {
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin') {
        return sendJson(res, 403, { message: 'Só administradores podem apagar o histórico.' });
      }
      const targetUser = (url.searchParams.get('user') || '').trim();
      if (!targetUser) return sendJson(res, 400, { message: 'Informe de qual usuário apagar o histórico.' });
      const { rowCount } = await q('DELETE FROM history WHERE username=$1', [targetUser]);
      await logAdminAction(sessionUser.username, 'apagar_historico_usuario', targetUser, `${rowCount} registro(s) apagado(s)`);
      return sendJson(res, 200, { ok: true, deleted: rowCount });
    }

    // Histórico: ver detalhes de uma execução (botão "Visualizar detalhes") —
    // usuário comum só vê os detalhes das próprias execuções; admin vê
    // qualquer uma. O consumo de créditos é calculado na hora, cruzando com
    // o livro-razão (credit_usage_log) pelo time + arquivo + janela de
    // tempo — nunca fica um número duplicado/guardado à parte que possa
    // dessincronizar do valor real cobrado.
    const historyDetailMatch = pathname.match(/^\/api\/history\/([^/]+)\/detalhes$/);
    if (historyDetailMatch && req.method === 'GET') {
      const id = Number(decodeURIComponent(historyDetailMatch[1]));
      if (!Number.isInteger(id)) return sendJson(res, 400, { message: 'id inválido' });
      const { rows } = await q('SELECT * FROM history WHERE id=$1', [id]);
      if (!rows.length) return sendJson(res, 404, { error: 'nao_encontrado' });
      const h = rows[0];
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin' && h.username !== sessionUser.username) {
        return sendJson(res, 403, { message: 'Você só pode ver os detalhes das suas próprias execuções.' });
      }

      let creditsAmount = 0;
      if (h.team_id) {
        const janelaMs = 5 * 60 * 1000; // 5 min de folga pra cobrir a diferença entre "formatar" e "validar"
        const de = new Date(new Date(h.ts).getTime() - janelaMs);
        const ate = new Date(new Date(h.ts).getTime() + janelaMs);
        const params = [h.team_id, de, ate];
        let sql = `SELECT COALESCE(SUM(amount),0) AS amount FROM credit_usage_log WHERE team_id=$1 AND created_at >= $2 AND created_at <= $3`;
        if (h.filename) { sql += ` AND file_name=$4`; params.push(h.filename); }
        const { rows: creditRows } = await q(sql, params);
        creditsAmount = Number(creditRows[0].amount) || 0;
      }

      // Registros antigos (de antes dessa coluna existir) não têm
      // whatsapp_validated preenchido — em vez de assumir "não validou" só
      // porque o campo está vazio, infere pela evidência real: só existe
      // consumo de crédito OU números marcados como "sem WhatsApp" se a
      // validação de verdade rodou (formatar sozinho não gera nenhum dos
      // dois). Pedido explícito: mostrar isso também nos registros antigos,
      // não só nos uploads novos.
      const whatsappValidadoInferido =
        h.whatsapp_validated != null ? h.whatsapp_validated : (creditsAmount > 0 || (h.no_whatsapp || 0) > 0);

      return sendJson(res, 200, {
        id: h.id, ts: h.ts, user: h.username, name: h.name, cliente: h.cliente, filename: h.filename,
        hsmCount: h.hsm_count, fileParts: h.file_parts,
        whatsappValidated: whatsappValidadoInferido,
        creditsConsumed: creditsAmount > 0,
        creditsAmount,
      });
    }

    // Histórico: apagar um único registro (somente admin)
    const historyDelMatch = pathname.match(/^\/api\/history\/([^/]+)$/);
    if (historyDelMatch && req.method === 'DELETE') {
      if (LOGIN_REQUIRED && sessionUser.role !== 'admin') {
        return sendJson(res, 403, { message: 'Só administradores podem apagar o histórico.' });
      }
      const id = Number(decodeURIComponent(historyDelMatch[1]));
      if (!Number.isInteger(id)) return sendJson(res, 400, { message: 'id inválido' });
      const { rows } = await q('SELECT username, filename FROM history WHERE id=$1', [id]);
      if (!rows.length) return sendJson(res, 404, { error: 'nao_encontrado' });
      await q('DELETE FROM history WHERE id=$1', [id]);
      await logAdminAction(sessionUser.username, 'apagar_historico_item', rows[0].username || '', rows[0].filename || '');
      return sendJson(res, 200, { ok: true });
    }

    // Histórico: registrar uma execução (ou atualizar uma já registrada, se
    // vier "data.historyId" — ver updateHistoryEntry acima)
    if (req.method === 'POST' && pathname === '/api/history') {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body.toString('utf-8')); } catch (e) { data = {}; }

      const historyId = Number(data.historyId);
      if (Number.isInteger(historyId) && historyId > 0) {
        const { rows } = await q('SELECT username FROM history WHERE id=$1', [historyId]);
        if (rows.length && rows[0].username === sessionUser.username) {
          await updateHistoryEntry(historyId, {
            total: data.total || 0, valid: data.valid || 0, invalid: data.invalid || 0,
            duplicates: data.duplicates || 0, noWhatsApp: data.noWhatsApp || 0,
            hsmCount: data.hsmCount || null, fileParts: data.fileParts || null,
            whatsappValidated: !!data.whatsappValidated,
          });
          return sendJson(res, 200, { ok: true, historyId });
        }
        // Se o id não existir mais ou não for dessa pessoa, cai pro fluxo
        // normal e cria um registro novo (não trava o download por causa
        // disso).
      }

      // Time SEMPRE resolvido no servidor a partir da sessão — nunca confia
      // no que o navegador manda (antes o campo "cliente" vinha vazio nesse
      // caminho, e a busca por time no Histórico silenciosamente não achava
      // essas execuções, mesmo o crédito tendo sido debitado certinho).
      let clienteResolvido = '';
      if (sessionUser.teamId) {
        const team = await findTeam(sessionUser.teamId);
        if (team) clienteResolvido = team.name;
      }
      const newId = await appendHistory({
        user: sessionUser.username, name: sessionUser.name, cliente: clienteResolvido, teamId: sessionUser.teamId || null,
        filename: data.filename || '',
        platform: data.platform === 'hyperflow' ? 'hyperflow' : 'wati', scheduled: false,
        total: data.total || 0, valid: data.valid || 0, invalid: data.invalid || 0,
        duplicates: data.duplicates || 0, noWhatsApp: data.noWhatsApp || 0,
        hsmCount: data.hsmCount || null, fileParts: data.fileParts || null,
        whatsappValidated: !!data.whatsappValidated,
      });
      return sendJson(res, 200, { ok: true, historyId: newId });
    }

    // Sugestões: enviar (qualquer usuário logado)
    if (req.method === 'POST' && pathname === '/api/suggestions') {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body.toString('utf-8')); } catch (e) { data = {}; }
      const message = (data.message || '').trim();
      if (!message) return sendJson(res, 400, { message: 'Escreva uma sugestão antes de enviar.' });
      await q(
        'INSERT INTO suggestions (username, name, message) VALUES ($1,$2,$3)',
        [sessionUser.username, sessionUser.name, message.slice(0, 2000)]
      );
      return sendJson(res, 200, { ok: true });
    }

    // Proxy: criação da tarefa de validação — aqui entram os créditos.
    // Importante: a resposta pro navegador é sempre um formato genérico,
    // criado por nós (nunca a resposta bruta do fornecedor) — ver
    // createLiveWaJob/getLiveWaJob e o comentário em createWaValidationTask.
    if (req.method === 'POST' && pathname === '/proxy/tasks') {
      const body = await readBody(req);
      const count = parseInt(req.headers['x-contact-count'], 10) || 0;
      // Nome do arquivo original enviado pelo usuário — só usado pra detalhar
      // a fatura em PDF de times pós-pagos (uma linha por arquivo processado).
      let fileNameHeader = null;
      try { fileNameHeader = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name']) : null; } catch (e) { fileNameHeader = null; }

      const apiKey = (await readSettings()).waApiKey;
      if (!apiKey) {
        return sendJson(res, 400, { error: 'api_key_nao_configurada', message: 'A chave do validador de WhatsApp ainda não foi configurada. Peça a um administrador para configurar em /admin.' });
      }

      const credCheck = await checkCreditsSufficient(sessionUser, count);
      if (LOGIN_REQUIRED && !credCheck.ok) {
        return sendJson(res, 402, { error: 'creditos_insuficientes', message: credCheck.message });
      }

      let upstream, text;
      try {
        upstream = await fetch('https://api.checknumber.ai/v1/tasks', {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'content-type': req.headers['content-type'] || '' },
          body,
        });
        text = await upstream.text();
      } catch (e) {
        console.error('[validador-whatsapp] falha de rede ao criar tarefa:', e.message);
        return sendJson(res, 502, { error: 'falha_validador', message: 'Não consegui falar com o serviço de verificação agora. Tente de novo em instantes.' });
      }
      if (!upstream.ok) {
        console.error('[validador-whatsapp] recusou a requisição:', upstream.status, text.slice(0, 500));
        // Pra admin, anexa o motivo real do fornecedor na mensagem — evita ter que
        // caçar isso nos logs do servidor toda vez. Usuário comum continua vendo só
        // a mensagem genérica (a marca do fornecedor nunca aparece pra eles).
        const debugSuffix =
          sessionUser.role === 'admin' ? ` [debug-admin: HTTP ${upstream.status} — ${text.slice(0, 300)}]` : '';
        return sendJson(res, 502, {
          error: 'falha_validador',
          message: 'O serviço de verificação recusou a requisição. Tente novamente ou avise o suporte.' + debugSuffix,
        });
      }
      let data;
      try { data = JSON.parse(text); } catch (e) { data = {}; }
      if (!data.task_id) {
        console.error('[validador-whatsapp] resposta sem task_id:', text.slice(0, 500));
        return sendJson(res, 502, { error: 'falha_validador', message: 'O serviço de verificação não retornou um identificador de tarefa.' });
      }

      if (LOGIN_REQUIRED && count > 0) {
        await deductCreditsFor(credCheck.creditSource, credCheck.team, sessionUser.username, count, fileNameHeader);
      }

      await pruneLiveWaJobs();
      const jobId = await createLiveWaJob(sessionUser.username, data.task_id);
      return sendJson(res, 200, { ok: true, jobId });
    }

    // Proxy: consulta de status da tarefa (por jobId nosso, nunca pelo
    // identificador do fornecedor, e nunca devolve a URL real do resultado)
    if (req.method === 'POST' && pathname === '/proxy/gettasks') {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body.toString('utf-8')); } catch (e) { data = {}; }
      const job = await getLiveWaJob(data.jobId, sessionUser.username);
      if (!job) {
        return sendJson(res, 404, { error: 'job_nao_encontrado', message: 'Essa verificação não foi encontrada (pode ter expirado). Envie os números de novo.' });
      }

      let status = job.status, total = job.total, success = job.success;
      let debugDetail = null; // guarda o motivo real (só exposto pra admin, ver resposta final abaixo)
      if (status === 'processing') {
        const apiKey = (await readSettings()).waApiKey;
        try {
          const fd = new FormData();
          fd.append('task_id', job.provider_task_id);
          const upstream = await fetch('https://api.checknumber.ai/v1/gettasks', { method: 'POST', headers: { 'X-API-Key': apiKey }, body: fd });
          const upstreamData = await upstream.json().catch(() => ({}));
          if (!upstream.ok || upstreamData.status === 'failed' || upstreamData.error) {
            console.error('[validador-whatsapp] falha reportada:', upstream.status, JSON.stringify(upstreamData).slice(0, 500));
            status = 'failed';
            debugDetail = `HTTP ${upstream.status} — ${JSON.stringify(upstreamData).slice(0, 300)}`;
            await updateLiveWaJob(job.id, { status });
          } else {
            total = upstreamData.total || total;
            success = upstreamData.success || success;
            if (upstreamData.status === 'exported' && upstreamData.result_url) {
              status = 'ready';
              // resultUrl fica só no banco/servidor — nunca vai pro navegador
              await updateLiveWaJob(job.id, { status, result_url: upstreamData.result_url, total, success });
            } else {
              await updateLiveWaJob(job.id, { total, success });
            }
          }
        } catch (e) {
          console.error('[validador-whatsapp] falha de rede ao consultar status:', e.message);
          // erro de rede pontual não marca como falha — tenta de novo no próximo poll do navegador
        }
      }

      return sendJson(res, 200, {
        status, // 'processing' | 'ready' | 'failed'
        total, success,
        message:
          status === 'failed'
            ? 'O serviço de verificação reportou uma falha. Tente novamente.' +
              (sessionUser.role === 'admin' && debugDetail ? ` [debug-admin: ${debugDetail}]` : '')
            : undefined,
      });
    }

    // Proxy: download do arquivo de resultado — só por jobId nosso; o
    // navegador nunca vê a URL real do fornecedor (evita tanto o vazamento
    // de marca quanto abuso da rota pra buscar qualquer URL arbitrária)
    if (req.method === 'GET' && pathname === '/proxy/download') {
      const jobId = url.searchParams.get('jobId');
      const job = await getLiveWaJob(jobId, sessionUser.username);
      if (!job || job.status !== 'ready' || !job.result_url) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Resultado não encontrado (pode ter expirado ou já ter sido baixado).');
      }
      let upstream, buf;
      try {
        upstream = await fetch(job.result_url);
        buf = Buffer.from(await upstream.arrayBuffer());
      } catch (e) {
        console.error('[validador-whatsapp] falha ao baixar resultado:', e.message);
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Falha ao baixar o resultado. Tente novamente.');
      }
      const isZip = job.result_url.toLowerCase().includes('.zip');
      await deleteLiveWaJob(job.id); // resultado já entregue, não precisa mais guardar
      res.writeHead(200, { 'content-type': isZip ? 'application/zip' : 'text/plain; charset=utf-8' });
      return res.end(buf);
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Rota não encontrada.');
  } catch (err) {
    console.error('Erro no servidor:', err);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Erro no servidor: ' + err.message);
  }
});

async function main() {
  try {
    await initSchema();
    await seedUsersIfNeeded();
    const { rows } = await q('SELECT count(*)::int AS n FROM users');
    LOGIN_REQUIRED = rows[0].n > 0;
  } catch (e) {
    console.error('\n[ERRO FATAL] Não consegui conectar/preparar o banco de dados:', e.message);
    console.error('Confira se a variável DATABASE_URL está configurada corretamente.\n');
  }

  server.listen(PORT, () => {
    console.log(`\nFormatador de Base rodando em: http://localhost:${PORT}`);
    console.log(LOGIN_REQUIRED ? 'Login exigido.' : 'Nenhum usuário configurado — rodando sem login.');
    console.log('Painel administrativo em /admin (requer papel admin).');
    console.log('Agendamentos em /agendamentos.');
    console.log('Verificador de agendamentos rodando a cada 30s.');
    console.log('Verificador de ciclos financeiros (times pós-pagos) rodando a cada hora.');
    console.log('Pressione Ctrl+C para encerrar.\n');
  });

  setInterval(checkDueScheduledJobs, 30000);
  setInterval(checkDueBillingCycles, 3600000);
  checkDueBillingCycles(); // roda uma vez já na subida do servidor, sem esperar a primeira hora
}

main();
