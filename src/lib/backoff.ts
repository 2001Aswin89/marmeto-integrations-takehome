export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;
export const BACKOFF_JITTER_MS = 250;

/**
 * Exponential backoff with jitter for the n-th failed attempt (1-based):
 * ~1s, 2s, 4s, 8s ... capped at 30s, plus 0–250ms so retries don't line up.
 * `random` is injectable so tests are deterministic.
 */
export function computeBackoff(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return exponential + Math.floor(random() * BACKOFF_JITTER_MS);
}

export const RETRY_AFTER_DEFAULT_MS = 1000;
export const RETRY_AFTER_MAX_MS = 60_000;

/**
 * Retry-After is either delay-seconds ("2") or an HTTP date. Missing or garbage falls back
 * to 1s; anything huge is clamped to 60s so one bad header can't stall a job for hours.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number {
  if (!value || value.trim() === '') return RETRY_AFTER_DEFAULT_MS;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(RETRY_AFTER_MAX_MS, Number(v) * 1000);
  // HTTP dates always contain a day/month name. Without this check Date.parse('-5') is "year -5".
  if (!/[a-z]{3}/i.test(v)) return RETRY_AFTER_DEFAULT_MS;
  const date = Date.parse(v);
  if (Number.isNaN(date)) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, date - now));
}
