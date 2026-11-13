import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCourierClient,
  PermanentError,
  RateLimitedError,
  RetryableError,
  toShipmentRequest,
  type ShipmentRequest,
} from '../src/courier.js';
import { orderPayload, startMock, type StartedMock } from './helpers.js';

const request: ShipmentRequest = { reference: '1001', address: { city: 'Bengaluru' }, items: [{ sku: 'A', quantity: 1 }] };

describe('T14 courier client against the mock', () => {
  let m: StartedMock;
  let courier: ReturnType<typeof createCourierClient>;

  before(async () => {
    m = await startMock({ force: 'ok', hangMs: 1000 });
    courier = createCourierClient({ baseUrl: m.url, timeoutMs: 200 });
  });
  after(async () => m.close());
  beforeEach(() => m.mock.reset());

  test('create returns the shipment; find lists it by reference', async () => {
    const created = await courier.create(request);
    assert.equal(created.reference, '1001');
    const found = await courier.find('1001');
    assert.deepEqual(
      found.map((s) => s.shipmentId),
      [created.shipmentId],
    );
    assert.deepEqual(await courier.find('nope'), []);
  });

  test('500 -> RetryableError(server_error)', async () => {
    m.mock.script(['500']);
    await assert.rejects(courier.create(request), (err: unknown) => {
      assert.ok(err instanceof RetryableError);
      assert.equal(err.reason, 'server_error');
      assert.equal(err.status, 500);
      return true;
    });
  });

  test('429 -> RateLimitedError with Retry-After in ms', async () => {
    m.mock.script(['429']);
    await assert.rejects(courier.create(request), (err: unknown) => {
      assert.ok(err instanceof RateLimitedError);
      assert.equal(err.retryAfterMs, 2000);
      return true;
    });
  });

  test('create-then-hang -> RetryableError(timeout), and the shipment exists anyway', async () => {
    m.mock.script(['hang']);
    await assert.rejects(courier.create(request), (err: unknown) => {
      assert.ok(err instanceof RetryableError);
      assert.equal(err.reason, 'timeout');
      return true;
    });
    assert.equal((await courier.find('1001')).length, 1, 'a timeout is "unknown", not "failed"');
  });

  test('a failing GET is a typed error too', async () => {
    m.mock.script({ get: ['500'] });
    await assert.rejects(courier.find('1001'), RetryableError);
  });

  test('other 4xx -> PermanentError(http_400)', async () => {
    await assert.rejects(courier.create({ ...request, reference: '' }), (err: unknown) => {
      assert.ok(err instanceof PermanentError);
      assert.equal(err.reason, 'http_400');
      return true;
    });
  });

  test('courier unreachable -> RetryableError(network)', async () => {
    const down = await startMock();
    await down.close();
    const offline = createCourierClient({ baseUrl: down.url, timeoutMs: 200 });
    await assert.rejects(offline.find('1001'), (err: unknown) => {
      assert.ok(err instanceof RetryableError);
      assert.equal(err.reason, 'network');
      return true;
    });
  });
});

describe('toShipmentRequest', () => {
  test('maps the order to { reference, address, items }', () => {
    const req = toShipmentRequest('1001', JSON.stringify(orderPayload(1001)));
    assert.equal(req.reference, '1001');
    assert.equal(req.address.city, 'Bengaluru');
    assert.deepEqual(req.items, [
      { sku: 'TSHIRT-M', quantity: 2 },
      { sku: 'MUG-01', quantity: 1 },
    ]);
  });

  test('an order that cannot be shipped is a PermanentError(invalid_payload)', () => {
    const cases = [
      orderPayload(1, { shipping_address: undefined }),
      orderPayload(1, { shipping_address: null }),
      orderPayload(1, { line_items: [] }),
      orderPayload(1, { line_items: [{ sku: 'A', quantity: 0 }] }),
    ];
    for (const payload of cases) {
      assert.throws(
        () => toShipmentRequest('1', JSON.stringify(payload)),
        (err: unknown) => err instanceof PermanentError && err.reason === 'invalid_payload',
      );
    }
    assert.throws(() => toShipmentRequest('1', 'not json'), PermanentError);
  });
});
