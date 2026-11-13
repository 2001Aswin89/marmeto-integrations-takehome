import type { Config } from './config.js';
import {
  PermanentError,
  RateLimitedError,
  RetryableError,
  toShipmentRequest,
  type CourierClient,
} from './courier.js';
import type { Db } from './db.js';
import { computeBackoff } from './lib/backoff.js';
import { log } from './lib/log.js';
import { claimNextJob, getOrder, markShipped, park, retryLater, type JobRow } from './repo.js';

export interface WorkerDeps {
  db: Db;
  courier: CourierClient;
  config: Config;
  now: () => number;
  random?: () => number;
}

export type Outcome =
  | { kind: 'shipped'; shipmentId: string }
  | { kind: 'adopted'; shipmentId: string; duplicates: number }
  | { kind: 'retry'; reason: string; attempts: number; runAt: number }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'parked'; reason: string };

/**
 * The decision logic for ONE claimed job.
 *
 * The courier is not idempotent and can create a shipment and then time out. So before every
 * POST we ask the courier what it already has (GET ?reference=orderId) and adopt it if found.
 * A failed GET is handled like any other failure: it never falls through to a POST.
 */
export async function processJob(job: JobRow, deps: WorkerDeps): Promise<Outcome> {
  const { db, courier, now } = deps;
  const orderId = job.order_id;
  const order = getOrder(db, orderId);

  if (order?.status === 'shipped' && order.shipment_id) {
    // Someone (reconciliation) confirmed it meanwhile. Just close the job.
    markShipped(db, { orderId, shipmentId: order.shipment_id, duplicates: order.duplicate_shipments, now: now() });
    return { kind: 'adopted', shipmentId: order.shipment_id, duplicates: order.duplicate_shipments };
  }

  try {
    if (!order) throw new PermanentError('order_missing');
    const request = toShipmentRequest(orderId, order.payload);

    // 1. Check: did an earlier attempt (that timed out or crashed) already create it?
    const existing = await courier.find(orderId);
    const [first] = existing;
    if (first) {
      const duplicates = existing.length - 1;
      if (duplicates > 0) {
        // Shouldn't happen with this design; worth an alert in production.
        log('warn', 'shipment.duplicates_found', { orderId, count: existing.length, kept: first.shipmentId });
      }
      markShipped(db, { orderId, shipmentId: first.shipmentId, duplicates, now: now() });
      log('info', 'shipment.adopted', { orderId, shipmentId: first.shipmentId, attempts: job.attempts });
      return { kind: 'adopted', shipmentId: first.shipmentId, duplicates };
    }

    // 2. Create: only when the courier confirmed it has nothing for this order.
    const created = await courier.create(request);
    markShipped(db, { orderId, shipmentId: created.shipmentId, duplicates: 0, now: now() });
    log('info', 'shipment.created', { orderId, shipmentId: created.shipmentId, attempts: job.attempts });
    return { kind: 'shipped', shipmentId: created.shipmentId };
  } catch (err) {
    return handleFailure(job, err, deps);
  }
}

function handleFailure(job: JobRow, err: unknown, deps: WorkerDeps): Outcome {
  const { db, config, now, random = Math.random } = deps;
  const base = { jobId: job.id, orderId: job.order_id, now: now() };

  // 429: the courier is fine, we're too fast. Not a failed attempt, but capped so it can't loop forever.
  if (err instanceof RateLimitedError) {
    const rateLimitHits = job.rate_limit_hits + 1;
    if (rateLimitHits > config.maxRateLimitHits) {
      return parked(db, { ...base, attempts: job.attempts, rateLimitHits, lastError: 'rate_limited_too_often' });
    }
    retryLater(db, {
      ...base,
      runAt: base.now + err.retryAfterMs,
      attempts: job.attempts,
      rateLimitHits,
      lastError: 'rate_limited',
    });
    log('info', 'job.rate_limited', { orderId: job.order_id, retryAfterMs: err.retryAfterMs, rateLimitHits });
    return { kind: 'rate_limited', retryAfterMs: err.retryAfterMs };
  }

  // Other 4xx or an unshippable payload: retrying won't help.
  if (err instanceof PermanentError) {
    return parked(db, { ...base, attempts: job.attempts, rateLimitHits: job.rate_limit_hits, lastError: err.reason });
  }

  // 5xx, timeout, network, bad response, or a bug: retry with backoff, park after MAX_ATTEMPTS.
  const reason = err instanceof RetryableError ? err.reason : 'unknown';
  if (!(err instanceof RetryableError)) {
    log('error', 'job.unexpected_error', { orderId: job.order_id, error: String((err as Error)?.stack ?? err) });
  }
  const attempts = job.attempts + 1;
  if (attempts >= config.maxAttempts) {
    return parked(db, { ...base, attempts, rateLimitHits: job.rate_limit_hits, lastError: reason });
  }
  const runAt = base.now + computeBackoff(attempts, random);
  retryLater(db, { ...base, runAt, attempts, rateLimitHits: job.rate_limit_hits, lastError: reason });
  log('info', 'job.retry_scheduled', { orderId: job.order_id, reason, attempts, inMs: runAt - base.now });
  return { kind: 'retry', reason, attempts, runAt };
}

function parked(db: Db, input: Parameters<typeof park>[1]): Outcome {
  park(db, input);
  log('warn', 'job.parked', {
    orderId: input.orderId,
    reason: input.lastError,
    attempts: input.attempts,
    hint: 'npm run failed / npm run replay -- <orderId>',
  });
  return { kind: 'parked', reason: input.lastError };
}

/** Claims and processes one ready job. Returns null when nothing is ready. Tests drive the worker with this. */
export async function processNextJob(deps: WorkerDeps): Promise<{ job: JobRow; outcome: Outcome } | null> {
  const job = claimNextJob(deps.db, deps.now(), deps.config.leaseMs);
  if (!job) return null;
  return { job, outcome: await processJob(job, deps) };
}

/**
 * Polls the jobs table, one job at a time. stop() lets the in-flight job finish first.
 */
export function startWorker(deps: WorkerDeps) {
  let stopping = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const loop = (async () => {
    log('info', 'worker.started', { pollMs: deps.config.workerPollMs });
    while (!stopping) {
      try {
        const result = await processNextJob(deps);
        if (!result) await sleep(deps.config.workerPollMs);
      } catch (err) {
        // e.g. SQLITE_BUSY: the job keeps its lease and is retried after it expires.
        log('error', 'worker.error', { error: String((err as Error)?.stack ?? err) });
        await sleep(deps.config.workerPollMs);
      }
    }
    log('info', 'worker.stopped');
  })();

  return {
    async stop() {
      stopping = true;
      wake?.();
      await loop;
    },
  };
}
