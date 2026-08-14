import pino from "pino";

// Logger estruturado compartilhado por API e workers.
// Atenção (LGPD, seção 9 do doc de arquitetura): nunca logar CPF/telefone completos.
// Use maskCpf/maskPhone abaixo antes de incluir esses campos em `contexto`.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["cpf", "telefone", "telefoneOriginal", "telefoneAtualizado", "telefoneValidado"],
    censor: "[redacted]",
  },
});

export function maskCpf(cpf: string | null | undefined): string | null {
  if (!cpf) return null;
  const digits = cpf.replace(/\D/g, "");
  if (digits.length !== 11) return "***";
  return `***.***.***-${digits.slice(-2)}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}
