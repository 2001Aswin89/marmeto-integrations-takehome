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

export function getOrder(db: Db, orderId: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as OrderRow | undefined;
}

export function getJob(db: Db, orderId: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE order_id = ?').get(orderId) as JobRow | undefined;
}
