import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getJob, getOrder } from '../src/repo.js';
import { processNextJob } from '../src/worker.js';
import { orderPayload, workerHarness } from './helpers.js';

type Harness = Awaited<ReturnType<typeof workerHarness>>;
let h: Harness;
afterEach(async () => h?.close());

describe('worker happy path', () => {
  test('checks first, finds nothing, creates exactly one shipment', async () => {
    h = await workerHarness({ force: 'ok' });
    h.enqueue(1001);
    const result = await processNextJob(h.deps);
    assert.equal(result?.outcome.kind, 'shipped');

    const [get, post] = h.mock.requests;
    assert.equal(get?.method, 'GET', 'the GET check comes before the POST');
    assert.equal(post?.method, 'POST');
    assert.equal(h.shipmentsAtCourier().length, 1);

    const order = getOrder(h.db, '1001');
    assert.equal(order?.status, 'shipped');
    assert.equal(order?.shipment_id, h.shipmentsAtCourier()[0]?.shipmentId);
    assert.equal(getJob(h.db, '1001')?.status, 'done');
    assert.equal(await processNextJob(h.deps), null, 'nothing left to do');
  });
});

describe('T5 courier creates the shipment, then times out', () => {
  test('the next attempt finds it with GET and adopts it: exactly ONE shipment', async () => {
    h = await workerHarness();
    h.mock.script(['hang']); // first POST creates, then hangs past our 200ms timeout
    h.enqueue(1001);

    const first = await processNextJob(h.deps);
    assert.deepEqual(first?.outcome, { kind: 'retry', reason: 'timeout', attempts: 1, runAt: h.clock.now() + 1000 });
    assert.equal(getOrder(h.db, '1001')?.status, 'pending', 'a timeout is "unknown", not shipped');
    assert.equal(h.shipmentsAtCourier().length, 1, 'but the courier did create it');

    assert.equal(await processNextJob(h.deps), null, 'not due yet: backoff is respected');
    h.clock.advance(1000);

    const second = await processNextJob(h.deps);
    assert.equal(second?.outcome.kind, 'adopted');
    assert.equal(h.posts().length, 1, 'no second POST');
    assert.equal(h.shipmentsAtCourier().length, 1, 'never two shipments');
    assert.equal(getOrder(h.db, '1001')?.shipment_id, h.shipmentsAtCourier()[0]?.shipmentId);
    assert.equal(getJob(h.db, '1001')?.status, 'done');
  });

  test('if duplicates already exist at the courier, keep the earliest and record the count', async () => {
    h = await workerHarness({ force: 'ok' });
    for (let i = 0; i < 2; i++) {
      await fetch(`${h.url}/shipments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference: '1001', address: {}, items: [] }),
      });
    }
    h.enqueue(1001);
    const result = await processNextJob(h.deps);
    assert.deepEqual(result?.outcome, { kind: 'adopted', shipmentId: 'shp_1', duplicates: 1 });
    assert.equal(getOrder(h.db, '1001')?.duplicate_shipments, 1);
    assert.equal(h.posts().length, 2, 'only the two pre-existing POSTs; the worker made none');
  });
});

describe('T6 429 with Retry-After', () => {
  test('reschedules for now + Retry-After and does not count as a failed attempt', async () => {
    h = await workerHarness();
    h.mock.script(['429', 'ok']);
    h.enqueue(1001);

    const result = await processNextJob(h.deps);
    assert.deepEqual(result?.outcome, { kind: 'rate_limited', retryAfterMs: 2000 });
    const job = getJob(h.db, '1001');
    assert.equal(job?.status, 'queued');
    assert.equal(job?.run_at, h.clock.now() + 2000);
    assert.equal(job?.attempts, 0);
    assert.equal(job?.rate_limit_hits, 1);

    h.clock.advance(1999);
    assert.equal(await processNextJob(h.deps), null, 'not before Retry-After');
    h.clock.advance(1);
    assert.equal((await processNextJob(h.deps))?.outcome.kind, 'shipped');
  });

  test('a 429 storm is capped by MAX_RATE_LIMIT_HITS', async () => {
    h = await workerHarness({ force: '429' }, { maxRateLimitHits: 3 });
    h.enqueue(1001);
    let outcome;
    for (let i = 0; i < 4; i++) {
      outcome = (await processNextJob(h.deps))?.outcome;
      h.clock.advance(2000);
    }
    assert.deepEqual(outcome, { kind: 'parked', reason: 'rate_limited_too_often' });
    assert.equal(getJob(h.db, '1001')?.attempts, 0);
  });
});

describe('T7 500 on every call', () => {
  test('backs off exponentially, then parks after MAX_ATTEMPTS', async () => {
    h = await workerHarness({ force: '500' }, { maxAttempts: 5 });
    h.enqueue(1001);

    const delays: number[] = [];
    for (let i = 1; i < 5; i++) {
      const result = await processNextJob(h.deps);
      assert.equal(result?.outcome.kind, 'retry');
      const job = getJob(h.db, '1001')!;
      assert.equal(job.attempts, i);
      delays.push(job.run_at - h.clock.now());
      h.clock.advance(job.run_at - h.clock.now());
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000]);

    const last = await processNextJob(h.deps);
    assert.deepEqual(last?.outcome, { kind: 'parked', reason: 'server_error' });
    const job = getJob(h.db, '1001');
    assert.equal(job?.status, 'dead');
    assert.equal(job?.attempts, 5);
    assert.equal(job?.last_error, 'server_error');
    assert.equal(getOrder(h.db, '1001')?.status, 'failed');

    h.clock.advance(3_600_000);
    assert.equal(await processNextJob(h.deps), null, 'parked jobs are not picked up again');
    assert.equal(h.shipmentsAtCourier().length, 0);
  });
});

describe('T11 a failed GET never falls through to a POST', () => {
  test('the check fails -> retry is scheduled, zero POSTs', async () => {
    h = await workerHarness({ force: 'ok' });
    h.mock.script({ get: ['500'] });
    h.enqueue(1001);

    const result = await processNextJob(h.deps);
    assert.equal(result?.outcome.kind, 'retry');
    assert.equal(h.posts().length, 0);
    assert.equal(getJob(h.db, '1001')?.attempts, 1);

    h.clock.advance(1000);
    assert.equal((await processNextJob(h.deps))?.outcome.kind, 'shipped');
    assert.equal(h.shipmentsAtCourier().length, 1);
  });

  test('a GET timeout is also just a retry', async () => {
    h = await workerHarness({ force: 'ok' });
    h.mock.script({ get: ['hang'] });
    h.enqueue(1001);
    const result = await processNextJob(h.deps);
    assert.deepEqual(result?.outcome.kind, 'retry');
    assert.equal(h.posts().length, 0);
  });
});

describe('permanent failures park immediately', () => {
  test('an order with no shipping address is parked as invalid_payload without calling the courier', async () => {
    h = await workerHarness({ force: 'ok' });
    h.enqueue(1001, orderPayload(1001, { shipping_address: null }));
    const result = await processNextJob(h.deps);
    assert.deepEqual(result?.outcome, { kind: 'parked', reason: 'invalid_payload' });
    assert.equal(h.mock.requests.length, 0);
    assert.equal(getOrder(h.db, '1001')?.status, 'failed');
  });
});
