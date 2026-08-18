import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEYLEN = 64;

// Hash de senha com scrypt (módulo nativo "crypto" do Node) — evita adicionar
// bcrypt/argon2 como dependência externa nova (menos risco pro build/lockfile,
// zero binário nativo pra compilar). scrypt já é considerado seguro o
// suficiente pra esse caso de uso (painel interno, poucas dezenas de contas).
//
// Formato salvo: "saltHex:hashHex" — o salt vai junto pra não precisar de
// coluna separada, e cada senha tem um salt aleatório próprio.
export async function hashSenha(senhaPlana: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(senhaPlana, salt, KEYLEN)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

// Comparação em tempo constante (timingSafeEqual) — evita vazar informação
// sobre a senha certa através de quanto tempo a comparação demora.
export async function verificarSenha(senhaPlana: string, hashSalvo: string): Promise<boolean> {
  const [salt, hashHex] = hashSalvo.split(":");
  if (!salt || !hashHex) return false;
  const hashArmazenado = Buffer.from(hashHex, "hex");
  const derivedKey = (await scrypt(senhaPlana, salt, KEYLEN)) as Buffer;
  if (derivedKey.length !== hashArmazenado.length) return false;
  return timingSafeEqual(derivedKey, hashArmazenado);
}

// Gera uma senha temporária legível (pro fluxo "gerar senha nova" no painel de
// usuários) — evita caracteres ambíguos (0/O, 1/l/I).
const ALFABETO_SENHA = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
export function gerarSenhaTemporaria(tamanho = 12): string {
  const bytes = randomBytes(tamanho);
  let senha = "";
  for (let i = 0; i < tamanho; i++) {
    senha += ALFABETO_SENHA[bytes[i] % ALFABETO_SENHA.length];
  }
  return senha;
}

// Token de sessão opaco (não é JWT) — 32 bytes aleatórios em hex.
export function gerarTokenSessao(): string {
  return randomBytes(32).toString("hex");
}
