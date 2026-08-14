// Backoff exponencial configurável (item 28 do escopo original). O schedule é uma
// lista de segundos de espera por tentativa; tentativas além do tamanho da lista usam
// o último valor (evita crescer indefinidamente).

export const DEFAULT_BACKOFF_SCHEDULE_SECONDS = [30, 60, 300, 900, 3600];
export const DEFAULT_MAX_TENTATIVAS = 5;

export function backoffSecondsForAttempt(
  attempt: number,
  schedule: number[] = DEFAULT_BACKOFF_SCHEDULE_SECONDS
): number {
  if (schedule.length === 0) {
    return 0;
  }
  const index = Math.min(Math.max(attempt - 1, 0), schedule.length - 1);
  return schedule[index];
}

export function nextAttemptDate(
  attempt: number,
  now: Date,
  schedule: number[] = DEFAULT_BACKOFF_SCHEDULE_SECONDS
): Date {
  const seconds = backoffSecondsForAttempt(attempt, schedule);
  return new Date(now.getTime() + seconds * 1000);
}

export function hasExceededMaxAttempts(
  attempt: number,
  maxTentativas: number = DEFAULT_MAX_TENTATIVAS
): boolean {
  return attempt >= maxTentativas;
}
