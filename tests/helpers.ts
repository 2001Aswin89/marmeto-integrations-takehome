import request from 'supertest';
import type { Express } from 'express';
import { createMockCourier } from '../mock-courier.js';
import { loadConfig, type Config } from '../src/config.js';
import { sign } from '../src/lib/hmac.js';

process.env.LOG_LEVEL ??= 'silent';

export const TEST_SECRET = 'test-secret';

/** Config for tests: independent of the developer's .env, small timeouts. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    webhookSecret: TEST_SECRET,
    dbPath: ':memory:',
    courierTimeoutMs: 200,
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
