import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const DEFAULT_WEBHOOK_SECRET = 'dev-secret-change-me';

export interface Config {
  port: number;
  webhookSecret: string;
  courierBaseUrl: string;
  dbPath: string;
  courierTimeoutMs: number;
  maxAttempts: number;
  maxRateLimitHits: number;
  maxReconcileRequeues: number;
  leaseMs: number;
  workerPollMs: number;
  reconcileMinAgeMs: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Config: ${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

/** Reads config from env (default: process.env + .env). Fails fast on bad values. */
export function loadConfig(env: Env = process.env): Config {
  const config: Config = {
    port: int(env, 'PORT', 3000, 0),
    webhookSecret: env.WEBHOOK_SECRET?.trim() || DEFAULT_WEBHOOK_SECRET,
    courierBaseUrl: (env.COURIER_BASE_URL?.trim() || 'http://localhost:4000').replace(/\/+$/, ''),
    dbPath: env.DB_PATH?.trim() || './data.db',
    courierTimeoutMs: int(env, 'COURIER_TIMEOUT_MS', 5000, 1),
    maxAttempts: int(env, 'MAX_ATTEMPTS', 5, 1),
    maxRateLimitHits: int(env, 'MAX_RATE_LIMIT_HITS', 20, 1),
    maxReconcileRequeues: int(env, 'MAX_RECONCILE_REQUEUES', 3, 0),
    leaseMs: int(env, 'LEASE_MS', 60000, 1),
    workerPollMs: int(env, 'WORKER_POLL_MS', 500, 1),
    reconcileMinAgeMs: int(env, 'RECONCILE_MIN_AGE_MS', 120000, 0),
  };

  // A job makes at most two courier calls (GET, then POST). The lease must outlive both,
  // or a slow-but-alive job could be reclaimed while it is still running.
  if (config.leaseMs < 3 * config.courierTimeoutMs) {
    throw new Error(
      `Config: LEASE_MS (${config.leaseMs}) must be at least 3 x COURIER_TIMEOUT_MS (${config.courierTimeoutMs})`,
    );
  }
  return config;
}

export function usesDefaultSecret(config: Config): boolean {
  return config.webhookSecret === DEFAULT_WEBHOOK_SECRET;
}
