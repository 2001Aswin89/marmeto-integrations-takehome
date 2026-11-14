import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getJob, getOrder } from '../src/repo.js';
import { createShutdown } from '../src/shutdown.js';
import { startWorker } from '../src/worker.js';
import { fakeClock, workerHarness } from './helpers.js';

/** A shutdown handler whose worker.stop() only finishes when the test says so. */
function harness() {
  const calls: string[] = [];
  const clock = fakeClock();
  let finishJob!: () => void;
  const inFlight = new Promise<void>((resolve) => (finishJob = resolve));
  const onSignal = createShutdown({
    closeHttp: () => calls.push('closeHttp'),
    stopWorker: async () => {
      calls.push('stopWorker');
      await inFlight;
      calls.push('workerStopped');
    },
    closeDb: () => calls.push('closeDb'),
    exit: (code) => calls.push(`exit(${code})`),
    now: clock.now,
  });
  return { calls, clock, onSignal, finishJob };
}

describe('graceful shutdown', () => {
  test('stops HTTP, waits for the in-flight job, then closes the DB and exits 0', async () => {
    const h = harness();
    const done = h.onSignal('SIGINT');
    await Promise.resolve();
    assert.deepEqual(h.calls, ['closeHttp', 'stopWorker'], 'still waiting for the job: DB open, no exit');
    h.finishJob();
    await done;
    assert.deepEqual(h.calls, ['closeHttp', 'stopWorker', 'workerStopped', 'closeDb', 'exit(0)']);
  });

  test('an echo of the same Ctrl+C (terminal + concurrently, or -k SIGTERM) does not force-quit', async () => {
    const h = harness();
    const done = h.onSignal('SIGINT');
    h.clock.advance(5);
    await h.onSignal('SIGINT'); // forwarded by concurrently
    await h.onSignal('SIGTERM'); // concurrently -k, after the mock exited
    assert.ok(!h.calls.includes('exit(1)'));
    h.finishJob();
    await done;
    assert.deepEqual(h.calls.at(-1), 'exit(0)');
  });

  test('a deliberate second Ctrl+C a moment later forces the exit', async () => {
    const h = harness();
    void h.onSignal('SIGINT');
    h.clock.advance(1500);
    await h.onSignal('SIGINT');
    assert.deepEqual(h.calls, ['closeHttp', 'stopWorker', 'exit(1)']);
  });
});

describe('worker.stop()', () => {
  let w: Awaited<ReturnType<typeof workerHarness>>;
  afterEach(async () => w?.close());

  test('lets the in-flight courier call finish and leaves no job holding a lease', async () => {
    w = await workerHarness({ force: 'hang' }, { workerPollMs: 10 }); // POST hangs; our timeout is 500ms
    w.enqueue(1001);
    const worker = startWorker({ ...w.deps, now: Date.now });
    await new Promise((r) => setTimeout(r, 50)); // the job is now mid-POST
    assert.equal(getJob(w.db, '1001')?.status, 'in_progress');

    const stopped = performance.now();
    await worker.stop();
    const waitedMs = performance.now() - stopped;

    const job = getJob(w.db, '1001');
    assert.ok(waitedMs >= 300, `stop() waited for the call (${waitedMs.toFixed(0)}ms)`);
    assert.equal(job?.status, 'queued', 'the outcome (a timeout) was recorded before stopping');
    assert.equal(job?.last_error, 'timeout');
    assert.equal(job?.locked_until, null, 'lease released: the next start picks it up immediately');
    assert.equal(getOrder(w.db, '1001')?.status, 'pending');
  });
});
