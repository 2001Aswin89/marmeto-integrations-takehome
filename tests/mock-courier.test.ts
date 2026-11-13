import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, type StartedMock } from './helpers.js';

const body = (reference: string) =>
  JSON.stringify({ reference, address: { city: 'Bengaluru' }, items: [{ sku: 'A', quantity: 1 }] });

function post(url: string, reference: string, init: RequestInit = {}) {
  return fetch(`${url}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: body(reference),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

async function list(url: string, reference: string) {
  const res = await fetch(`${url}/shipments?reference=${reference}`);
  return (await res.json()) as { shipmentId: string; reference: string }[];
}

describe('T0 mock courier', () => {
  let m: StartedMock;
  afterEach(async () => m.close());

  describe('with forced success', () => {
    beforeEach(async () => {
      m = await startMock({ force: 'ok' });
    });

    test('POST creates a shipment and GET lists it by reference', async () => {
      const res = await post(m.url, '1001');
      assert.equal(res.status, 201);
      const created = (await res.json()) as { shipmentId: string; reference: string };
      assert.equal(created.reference, '1001');
      assert.deepEqual(
        (await list(m.url, '1001')).map((s) => s.shipmentId),
        [created.shipmentId],
      );
      assert.deepEqual(await list(m.url, 'other'), []);
    });

    test('is not idempotent: the same reference twice creates two shipments, in order', async () => {
      const a = (await (await post(m.url, '1001')).json()) as { shipmentId: string };
      const b = (await (await post(m.url, '1001')).json()) as { shipmentId: string };
      assert.notEqual(a.shipmentId, b.shipmentId);
      assert.deepEqual(
        (await list(m.url, '1001')).map((s) => s.shipmentId),
        [a.shipmentId, b.shipmentId],
      );
    });

    test('POST without a reference is a 400', async () => {
      const res = await fetch(`${m.url}/shipments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 400);
    });

    test('the x-mock-force header overrides the instance setting', async () => {
      const res = await post(m.url, '1001', { headers: { 'x-mock-force': '500' } });
      assert.equal(res.status, 500);
      assert.deepEqual(await list(m.url, '1001'), []);
    });
  });

  test('429 carries Retry-After: 2 and creates nothing', async () => {
    m = await startMock();
    m.mock.script(['429']);
    const res = await post(m.url, '1001');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '2');
    assert.deepEqual(await list(m.url, '1001'), []);
  });

  test('hang creates the shipment BEFORE the client gives up', async () => {
    m = await startMock({ hangMs: 2000 });
    m.mock.script(['hang']);
    await assert.rejects(post(m.url, '1001', { signal: AbortSignal.timeout(100) }), {
      name: 'TimeoutError',
    });
    const found = await list(m.url, '1001');
    assert.equal(found.length, 1, 'the courier created it even though we timed out');
  });

  test('random outcomes follow the documented rates (20% 500, 10% 429, 10% hang)', async () => {
    const draws = [0.1, 0.25, 0.35, 0.9];
    m = await startMock({ random: () => draws.shift() ?? 0.9, hangMs: 50 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(m.url, `r${i}`)).status);
    assert.deepEqual(statuses, [500, 429, 201, 201]); // the hang answers 201 after 50ms
    assert.deepEqual(
      m.mock.requests.map((r) => r.outcome),
      ['500', '429', 'hang', 'ok'],
    );
  });

  test('scripted GET failures (used to prove a failed check never leads to a POST)', async () => {
    m = await startMock();
    m.mock.script({ get: ['500'] });
    assert.equal((await fetch(`${m.url}/shipments?reference=1`)).status, 500);
    assert.equal((await fetch(`${m.url}/shipments?reference=1`)).status, 200);
  });
});
