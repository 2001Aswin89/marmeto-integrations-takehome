import type { Db } from './db.js';

export type OrderStatus = 'pending' | 'shipped' | 'failed';
export type JobStatus = 'queued' | 'in_progress' | 'done' | 'dead';

export interface OrderRow {
  order_id: string;
  payload: string;
  status: OrderStatus;
  shipment_id: string | null;
  duplicate_shipments: number;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: number;
  order_id: string;
  status: JobStatus;
  attempts: number;
  rate_limit_hits: number;
  reconcile_requeues: number;
  run_at: number;
  locked_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type Duplicate = false | 'webhook' | 'order';

/**
 * Records the webhook, the order and its job in ONE transaction, so an order we said
 * 200 to always has a job (no lost work if we crash right after replying).
 *
 * Two idempotency layers:
 *  - same X-Shop-Webhook-Id   -> webhook_events primary key -> 'webhook'
 *  - same order, new webhook  -> orders primary key         -> 'order'
 */
export function ingestWebhook(
  db: Db,
  input: { webhookId: string | null; orderId: string; rawBody: string; now: number },
): Duplicate {
  const { webhookId, orderId, rawBody, now } = input;
  return db.transaction((): Duplicate => {
    if (webhookId !== null) {
      const event = db
        .prepare('INSERT OR IGNORE INTO webhook_events (webhook_id, order_id, received_at) VALUES (?, ?, ?)')
        .run(webhookId, orderId, now);
      if (event.changes === 0) return 'webhook';
    }

    const order = db
      .prepare(
        `INSERT OR IGNORE INTO orders (order_id, payload, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(orderId, rawBody, now, now);
    if (order.changes === 0) return 'order';

    db.prepare(
      `INSERT INTO jobs (order_id, status, run_at, created_at, updated_at)
       VALUES (?, 'queued', ?, ?, ?)`,
    ).run(orderId, now, now, now);
    return false;
  })();
}

/**
 * Atomically claims the next ready job and leases it for `leaseMs`. A job whose lease has
 * expired (the worker died mid-job) is claimable again. One statement, so two claimers can
 * never get the same job.
 *
 * Reclaiming an expired lease counts as a failed attempt: otherwise a payload that crashes
 * the worker every time would be retried forever instead of being parked.
 */
export function claimNextJob(db: Db, now: number, leaseMs: number): JobRow | undefined {
  return db
    .prepare(
      `UPDATE jobs SET
         status       = 'in_progress',
         locked_until = @lockedUntil,
         attempts     = attempts + CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END,
         last_error   = CASE WHEN status = 'in_progress' THEN 'lease_expired' ELSE last_error END,
         updated_at   = @now
       WHERE id = (
         SELECT id FROM jobs
         WHERE (status = 'queued' AND run_at <= @now)
            OR (status = 'in_progress' AND locked_until <= @now)
         ORDER BY run_at, id
         LIMIT 1
       )
       RETURNING *`,
    )
    .get({ now, lockedUntil: now + leaseMs }) as JobRow | undefined;
}

/** Order -> shipped and job -> done, together (invariant: shipped <=> done). */
export function markShipped(
  db: Db,
  input: { orderId: string; shipmentId: string; duplicates: number; now: number },
): void {
  const { orderId, shipmentId, duplicates, now } = input;
  db.transaction(() => {
    db.prepare(
      `UPDATE orders SET status = 'shipped', shipment_id = ?, duplicate_shipments = ?, updated_at = ?
       WHERE order_id = ?`,
    ).run(shipmentId, duplicates, now, orderId);
    db.prepare(`UPDATE jobs SET status = 'done', locked_until = NULL, updated_at = ? WHERE order_id = ?`).run(
      now,
      orderId,
    );
  })();
}

/** Puts a claimed job back in the queue for a later attempt. */
export function retryLater(
  db: Db,
  input: { jobId: number; runAt: number; attempts: number; rateLimitHits: number; lastError: string; now: number },
): void {
  db.prepare(
    `UPDATE jobs SET status = 'queued', locked_until = NULL, run_at = @runAt, attempts = @attempts,
       rate_limit_hits = @rateLimitHits, last_error = @lastError, updated_at = @now
     WHERE id = @jobId`,
  ).run(input);
}

/** Parks a job (dead-letter): job -> dead, order -> failed. Visible via `npm run failed`, replayable. */
export function park(
  db: Db,
  input: { jobId: number; orderId: string; attempts: number; rateLimitHits: number; lastError: string; now: number },
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE jobs SET status = 'dead', locked_until = NULL, attempts = @attempts,
         rate_limit_hits = @rateLimitHits, last_error = @lastError, updated_at = @now
       WHERE id = @jobId`,
    ).run(input);
    db.prepare(`UPDATE orders SET status = 'failed', updated_at = @now WHERE order_id = @orderId`).run(input);
  })();
}

export function getOrder(db: Db, orderId: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as OrderRow | undefined;
}

export function getJob(db: Db, orderId: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE order_id = ?').get(orderId) as JobRow | undefined;
}
