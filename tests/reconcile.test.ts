import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.js';
import { getJob, getOrder } from '../src/repo.js';
import { processNextJob } from '../src/worker.js';
import { orderPayload, workerHarness } from './helpers.js';

type Harness = Awaited<ReturnType<typeof workerHarness>>;
let h: Harness;
afterEach(async () => h?.close());

const MIN_AGE = 120_000;

/** Puts a job (and its order, to keep the invariant) into a given state. */
function setState(h: Harness, orderId: string, job: Record<string, unknown>) {
  const sets = Object.keys(job).map((k) => `${k} = @${k}`).join(', ');
  h.db.prepare(`UPDATE jobs SET ${sets} WHERE order_id = @orderId`).run({ ...job, orderId });
  if (job.status === 'dead') h.db.prepare(`UPDATE orders SET status = 'failed' WHERE order_id = ?`).run(orderId);
}

async function courierCreates(h: Harness, reference: string) {
  await fetch(`${h.url}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mock-force': 'ok' },
    body: JSON.stringify({ reference, address: {}, items: [] }),
  });
}

const requestsFor = (h: Harness, ref: string) => h.mock.requests.filter((r) => r.reference === ref);

describe('T9 reconciliation', () => {
  test('adopts, requeues, flags or skips each unconfirmed order, and never POSTs', async () => {
    h = await workerHarness({ force: 'ok' }, { maxReconcileRequeues: 3 });
    for (const id of ['1', '2', '3', '4', '5', '6', '8']) h.enqueue(id);
    h.clock.advance(MIN_AGE + 1);
    h.enqueue('7'); // too young to reconcile

    // (1) parked after timeouts, but the courier DID create it  -> adopt
    setState(h, '1', { status: 'dead', last_error: 'timeout', attempts: 5 });
    await courierCreates(h, '1');
    // (2) parked after 5xx, courier has nothing                  -> requeue
    setState(h, '2', { status: 'dead', last_error: 'server_error', attempts: 5 });
    // (3) parked for a permanent reason                          -> needs attention
    setState(h, '3', { status: 'dead', last_error: 'invalid_payload' });
    // (4) the worker is on it right now (live lease)             -> skipped, not even checked
    setState(h, '4', { status: 'in_progress', locked_until: h.clock.now() + 30_000 });
    // (5) transient, but reconcile already retried it 3 times    -> needs attention
    setState(h, '5', { status: 'dead', last_error: 'server_error', reconcile_requeues: 3 });
    // (6) queued, waiting out a backoff, nothing at the courier  -> in flight, left alone
    setState(h, '6', { status: 'queued', run_at: h.clock.now() + 8000, attempts: 3 });
    // (8) queued, but the courier already has it                -> adopt
    await courierCreates(h, '8');

    const postsBefore = h.posts().length;
    const { summary, details } = await reconcile({ ...h.deps }, { minAgeMs: MIN_AGE });

    assert.equal(h.posts().length, postsBefore, 'reconciliation never POSTs');
    assert.deepEqual(summary, { checked: 6, adopted: 2, requeued: 1, needs_attention: 2, in_flight: 1, errored: 0 });
    assert.deepEqual(
      Object.fromEntries(details.map((d) => [d.orderId, d.action])),
      { '1': 'adopted', '2': 'requeued', '3': 'needs_attention', '5': 'needs_attention', '6': 'in_flight', '8': 'adopted' },
    );
    assert.equal(requestsFor(h, '4').length, 0, 'a live lease is not even checked');
    assert.equal(requestsFor(h, '7').length, 0, 'a young order is not checked');

    assert.equal(getOrder(h.db, '1')?.status, 'shipped');
    assert.equal(getOrder(h.db, '1')?.shipment_id, h.shipmentsAtCourier('1')[0]?.shipmentId);
    assert.equal(getJob(h.db, '1')?.status, 'done');

    const requeued = getJob(h.db, '2');
    assert.equal(requeued?.status, 'queued');
    assert.equal(requeued?.attempts, 0);
    assert.equal(requeued?.reconcile_requeues, 1);
    assert.equal(getOrder(h.db, '2')?.status, 'pending');

    assert.equal(getJob(h.db, '6')?.run_at, h.clock.now() + 8000, "a scheduled retry's backoff is kept");
  });

  test('running it again changes nothing that is already settled', async () => {
    h = await workerHarness({ force: 'ok' });
    h.enqueue('2');
    h.clock.advance(MIN_AGE + 1);
    setState(h, '2', { status: 'dead', last_error: 'server_error' });

    const first = await reconcile(h.deps, { minAgeMs: MIN_AGE });
    assert.equal(first.summary.requeued, 1);
    const second = await reconcile(h.deps, { minAgeMs: MIN_AGE });
    assert.deepEqual(second.summary, { checked: 1, adopted: 0, requeued: 0, needs_attention: 0, in_flight: 1, errored: 0 });
    assert.equal(getJob(h.db, '2')?.reconcile_requeues, 1);

    // The worker then ships it, and reconciliation has nothing left to look at.
    assert.equal((await processNextJob(h.deps))?.outcome.kind, 'shipped');
    const third = await reconcile(h.deps, { minAgeMs: MIN_AGE });
    assert.equal(third.summary.checked, 0);
    assert.equal(h.shipmentsAtCourier('2').length, 1);
  });

  test('end to end: create-then-timeout, parked, reconciled -> exactly one shipment', async () => {
    h = await workerHarness({ force: 'hang' }, { maxAttempts: 1 });
    h.enqueue('9', orderPayload('9'));
    assert.equal((await processNextJob(h.deps))?.outcome.kind, 'parked');
    h.clock.advance(MIN_AGE + 1);

    const { summary } = await reconcile(h.deps, { minAgeMs: MIN_AGE });
    assert.equal(summary.adopted, 1);
    assert.equal(getOrder(h.db, '9')?.status, 'shipped');
    assert.equal(h.shipmentsAtCourier('9').length, 1);
  });

  test('a courier error skips that order; a 429 stops the run early', async () => {
    h = await workerHarness({ force: 'ok' });
    for (const id of ['1', '2', '3']) h.enqueue(id);
    h.clock.advance(MIN_AGE + 1);
    for (const id of ['1', '2', '3']) setState(h, id, { status: 'dead', last_error: 'timeout' });

    h.mock.script({ get: ['500', '429'] });
    const { summary, details } = await reconcile(h.deps, { minAgeMs: MIN_AGE });
    assert.equal(summary.errored, 3);
    assert.equal(details.find((d) => d.orderId === '3')?.note, 'courier rate limited, run stopped early');
    assert.equal(requestsFor(h, '3').length, 0, 'no call after the 429');
    for (const id of ['1', '2', '3']) assert.equal(getJob(h.db, id)?.status, 'dead', 'unchanged; next run retries');
  });
});
