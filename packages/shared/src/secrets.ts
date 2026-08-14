// Resolve uma "credenciais_ref" (armazenada no Endpoint) para o valor real do
// segredo — nunca em texto puro no banco, sempre a partir de variável de ambiente
// do processo (item 19/41 do doc de arquitetura: "credenciais nunca expostas no
// frontend ou código-fonte"). Trocar por um secret manager real (Vault, AWS Secrets
// Manager, etc.) é uma troca isolada nesta função.
export function resolveSecret(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  return process.env[ref];
}
