// Node's built-in SQLite (node:sqlite, Node >= 22.13): synchronous, real transactions, RETURNING,
// and no native module to compile, so `npm install` works on any machine without build tools.
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_events (
  webhook_id   TEXT NOT NULL PRIMARY KEY,          -- X-Shop-Webhook-Id
  order_id     TEXT NOT NULL,
  received_at  INTEGER NOT NULL                    -- epoch ms
);

CREATE TABLE IF NOT EXISTS orders (
  order_id            TEXT NOT NULL PRIMARY KEY,   -- String(payload.id)
  payload             TEXT NOT NULL,               -- raw body as received
  status              TEXT NOT NULL CHECK (status IN ('pending', 'shipped', 'failed')),
  shipment_id         TEXT,
  duplicate_shipments INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id            TEXT NOT NULL UNIQUE REFERENCES orders(order_id),
  status              TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'done', 'dead')),
  attempts            INTEGER NOT NULL DEFAULT 0,  -- failed attempts: 5xx, timeout, network, lease expiry
  rate_limit_hits     INTEGER NOT NULL DEFAULT 0,  -- 429s, counted separately
  reconcile_requeues  INTEGER NOT NULL DEFAULT 0,  -- automatic requeues by reconciliation
  run_at              INTEGER NOT NULL,            -- not before (epoch ms)
  locked_until        INTEGER,                     -- lease expiry while in_progress
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, run_at);
`;

/** Opens (or creates) the database and applies the schema. Use ':memory:' in tests. */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;    -- readers don't block the writer
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;   -- service, reconcile and replay are separate processes
  `);
  db.exec(SCHEMA);
  return db;
}

/**
 * Runs fn in one transaction: all of it commits, or none of it does.
 * BEGIN IMMEDIATE takes the write lock up front, so a concurrent writer waits (busy_timeout)
 * instead of failing halfway through.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
