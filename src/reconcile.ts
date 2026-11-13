import type { Config } from './config.js';
import { RateLimitedError, type CourierClient } from './courier.js';
import type { Db } from './db.js';
import { log } from './lib/log.js';
import { adoptShipment, requeueParked, type JobStatus } from './repo.js';

export type ReconcileAction = 'adopted' | 'requeued' | 'needs_attention' | 'in_flight' | 'errored';

export interface ReconcileResult {
  summary: { checked: number } & Record<ReconcileAction, number>;
  details: { orderId: string; action: ReconcileAction; note?: string }[];
}

export interface ReconcileDeps {
  db: Db;
  courier: CourierClient;
  config: Config;
  now: () => number;
}

interface Candidate {
  order_id: string;
  job_status: JobStatus;
  last_error: string | null;
  reconcile_requeues: number;
}

/** Errors that a retry can't fix: a human should look before anything is replayed. */
export function isPermanentError(lastError: string | null): boolean {
  return lastError !== null && (lastError.startsWith('http_') || lastError === 'invalid_payload' || lastError === 'order_missing');
}

/**
 * Finds orders with no confirmed shipment and safely re-tries them.
 *
 * Never POSTs. For each order it asks the courier first (GET ?reference=orderId):
 *  - the courier has it                         -> adopt it (covers create-then-timeout)
 *  - it doesn't, job parked for a transient error -> requeue for the worker, at most
 *    MAX_RECONCILE_REQUEUES times (the worker checks again before it creates)
 *  - it doesn't, permanent error / budget used    -> needs_attention (human replay)
 *  - it doesn't, job queued or being reclaimed    -> in_flight (the worker has it)
 * Jobs under a live lease are skipped entirely, so it never races the worker.
 * Safe to run any number of times.
 */
export async function reconcile(
  deps: ReconcileDeps,
  { minAgeMs = deps.config.reconcileMinAgeMs }: { minAgeMs?: number } = {},
): Promise<ReconcileResult> {
  const { db, courier, config, now } = deps;
  const startedAt = now();

  const candidates = db
    .prepare(
      `SELECT o.order_id, j.status AS job_status, j.last_error, j.reconcile_requeues
       FROM orders o JOIN jobs j ON j.order_id = o.order_id
       WHERE o.status != 'shipped'
         AND o.created_at <= @cutoff
         AND NOT (j.status = 'in_progress' AND j.locked_until > @now)
       ORDER BY o.created_at, o.order_id`,
    )
    .all({ cutoff: startedAt - minAgeMs, now: startedAt }) as unknown as Candidate[];

  const result: ReconcileResult = {
    summary: { checked: 0, adopted: 0, requeued: 0, needs_attention: 0, in_flight: 0, errored: 0 },
    details: [],
  };
  const record = (orderId: string, action: ReconcileAction, note?: string) => {
    result.summary[action]++;
    result.details.push(note ? { orderId, action, note } : { orderId, action });
    log(action === 'errored' || action === 'needs_attention' ? 'warn' : 'info', `reconciled.${action}`, {
      orderId,
      ...(note ? { note } : {}),
    });
  };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    result.summary.checked++;

    let existing;
    try {
      existing = await courier.find(c.order_id);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        // Don't hammer a courier that asked us to slow down; the next run picks the rest up.
        for (const rest of candidates.slice(i)) {
          if (rest !== c) result.summary.checked++;
          record(rest.order_id, 'errored', 'courier rate limited, run stopped early');
        }
        break;
      }
      record(c.order_id, 'errored', (err as Error).message);
      continue;
    }

    const [first] = existing;
    if (first) {
      const adopted = adoptShipment(db, {
        orderId: c.order_id,
        shipmentId: first.shipmentId,
        duplicates: existing.length - 1,
        now: now(),
      });
      record(c.order_id, adopted ? 'adopted' : 'in_flight', adopted ? first.shipmentId : 'worker claimed it meanwhile');
      continue;
    }

    if (c.job_status !== 'dead') {
      record(c.order_id, 'in_flight', `job ${c.job_status}`);
    } else if (isPermanentError(c.last_error)) {
      record(c.order_id, 'needs_attention', `permanent error: ${c.last_error}`);
    } else if (c.reconcile_requeues >= config.maxReconcileRequeues) {
      record(c.order_id, 'needs_attention', `already requeued ${c.reconcile_requeues}x (last: ${c.last_error})`);
    } else if (requeueParked(db, c.order_id, now())) {
      record(c.order_id, 'requeued', `was ${c.last_error}`);
    } else {
      record(c.order_id, 'in_flight', 'job changed meanwhile');
    }
  }

  log('info', 'reconcile.summary', result.summary);
  return result;
}
