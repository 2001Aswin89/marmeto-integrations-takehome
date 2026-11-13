// Reconciliation stub: one run, then exit. In production this would run on a schedule (cron).
//
//   npm run reconcile                     orders older than RECONCILE_MIN_AGE_MS (default 2 min)
//   npm run reconcile -- --min-age 0      every unconfirmed order (demos)

import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createCourierClient } from '../courier.js';
import { openDb } from '../db.js';
import { reconcile } from '../reconcile.js';

const { values: args } = parseArgs({ options: { 'min-age': { type: 'string' } } });

const config = loadConfig();
const minAgeMs = args['min-age'] === undefined ? config.reconcileMinAgeMs : Number(args['min-age']);
if (!Number.isInteger(minAgeMs) || minAgeMs < 0) {
  console.error('--min-age must be a whole number of milliseconds >= 0');
  process.exit(1);
}

process.env.LOG_LEVEL ??= 'silent'; // the table below is the output
const db = openDb(config.dbPath);
const courier = createCourierClient({ baseUrl: config.courierBaseUrl, timeoutMs: config.courierTimeoutMs });

try {
  const { summary, details } = await reconcile({ db, courier, config, now: Date.now }, { minAgeMs });
  if (details.length > 0) console.table(details);
  console.log(
    `checked ${summary.checked}: adopted ${summary.adopted}, requeued ${summary.requeued}, ` +
      `needs attention ${summary.needs_attention}, in flight ${summary.in_flight}, errored ${summary.errored}`,
  );
} finally {
  db.close();
}
