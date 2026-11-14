import request from 'supertest';
import type { Express } from 'express';
import { createMockCourier } from '../mock-courier.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Db } from '../src/db.js';
import { sign } from '../src/lib/hmac.js';

process.env.LOG_LEVEL ??= 'silent';

export const TEST_SECRET = 'test-secret';

/** Config for tests: independent of the developer's .env, small timeouts. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    webhookSecret: TEST_SECRET,
    dbPath: ':memory:',
    courierTimeoutMs: 500,
    leaseMs: 60_000,
    ...overrides,
  };
}

type MockOptions = Parameters<typeof createMockCourier>[0];

/** Starts the mock courier in-process on a random port. */
export async function startMock(options: MockOptions = {}) {
  const mock = createMockCourier({ log: false, ...options });
  const server = await mock.listen(0);
  return { mock, url: server.url, close: server.close };
}

export type StartedMock = Awaited<ReturnType<typeof startMock>>;

export function orderPayload(id: number | string = 1001, extra: Record<string, unknown> = {}) {
  return {
    id,
    email: 'buyer@example.com',
    shipping_address: { name: 'Asha Rao', address1: '12 MG Road', city: 'Bengaluru', zip: '560001', country: 'IN' },
    line_items: [
      { sku: 'TSHIRT-M', quantity: 2 },
      { sku: 'MUG-01', quantity: 1 },
    ],
    ...extra,
  };
}

/** A clock tests can move by hand, so nothing waits for real backoff or Retry-After. */
export function fakeClock(start = Date.parse('2026-11-13T10:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * Mock courier + in-memory DB + fake clock + worker deps, with one helper to enqueue an order.
 * The courier timeout is a small real timeout (500ms); the mock's hang is 2s.
 */
export async function workerHarness(
  mockOptions: MockOptions = {},
  configOverrides: Partial<Config> = {},
) {
  const { openDb } = await import('../src/db.js');
  const { createCourierClient } = await import('../src/courier.js');
  const { ingestWebhook } = await import('../src/repo.js');

  const courierMock = await startMock({ hangMs: 2000, ...mockOptions });
  const db = openDb(':memory:');
  const clock = fakeClock();
  const config = testConfig({ courierBaseUrl: courierMock.url, ...configOverrides });
  const courier = createCourierClient({ baseUrl: courierMock.url, timeoutMs: config.courierTimeoutMs, now: clock.now });
  const deps = { db, courier, config, now: clock.now, random: () => 0 };

  return {
    ...courierMock,
    db,
    clock,
    config,
    deps,
    enqueue(orderId: string | number = 1001, payload: Record<string, unknown> = orderPayload(orderId)) {
      ingestWebhook(db, { webhookId: null, orderId: String(orderId), rawBody: JSON.stringify(payload), now: clock.now() });
    },
    /** Shipments the courier holds for a reference: the number that must never exceed 1. */
    shipmentsAtCourier: (reference: string | number = 1001) =>
      courierMock.mock.store.filter((s) => s.reference === String(reference)),
    posts: () => courierMock.mock.requests.filter((r) => r.method === 'POST'),
  };
}

/** Row counts of the three tables. */
export function counts(db: Db) {
  const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { webhook_events: n('webhook_events'), orders: n('orders'), jobs: n('jobs') };
}

/** Sends a correctly signed webhook. `body` is sent byte-for-byte as given. */
export function signedPost(
  app: Express,
  body: string,
  { webhookId, secret = TEST_SECRET, signature }: { webhookId?: string | null; secret?: string; signature?: string } = {},
) {
  let req = request(app)
    .post('/webhooks/orders-create')
    .set('Content-Type', 'application/json')
    .set('X-Shop-Hmac-Sha256', signature ?? sign(secret, body));
  if (webhookId !== null) req = req.set('X-Shop-Webhook-Id', webhookId ?? `wh_${Math.random().toString(36).slice(2)}`);
  return req.send(body);
}
