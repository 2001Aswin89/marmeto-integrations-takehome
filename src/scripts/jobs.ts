// Parked jobs: see them, replay them. Works on the DB directly, with or without the service running.
//
//   npm run failed                    list parked (dead-lettered) jobs
//   npm run replay -- <orderId>       put a parked job back in the queue

import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { listFailed, replayJob } from '../repo.js';

const [command, orderId] = process.argv.slice(2);
const config = loadConfig();
const db = openDb(config.dbPath);

try {
  if (command === 'failed') {
    const rows = listFailed(db);
    if (rows.length === 0) {
      console.log('No parked jobs.');
    } else {
      console.table(
        rows.map((r) => ({
          orderId: r.order_id,
          lastError: r.last_error,
          attempts: r.attempts,
          rateLimitHits: r.rate_limit_hits,
          reconcileRequeues: r.reconcile_requeues,
          parkedAt: new Date(r.updated_at).toISOString(),
        })),
      );
      console.log(`Replay one with: npm run replay -- <orderId>`);
    }
  } else if (command === 'replay') {
    if (!orderId) throw new Error('usage: npm run replay -- <orderId>');
    const result = replayJob(db, orderId, Date.now());
    const messages = {
      replayed: `Order ${orderId} is queued again. The worker checks the courier before creating, so this is safe.`,
      not_found: `Order ${orderId} not found.`,
      already_shipped: `Order ${orderId} is already shipped; nothing to replay.`,
      not_parked: `Order ${orderId} is not parked (it is queued or in progress); nothing to replay.`,
    } as const;
    console.log(messages[result]);
    if (result !== 'replayed') process.exitCode = 1;
  } else {
    throw new Error('usage: jobs.ts failed | replay <orderId>');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
