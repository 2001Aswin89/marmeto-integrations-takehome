import Database from 'better-sqlite3';

export type Db = Database.Database;

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
  const db = new Database(path);
  db.pragma('journal_mode = WAL'); // readers don't block the writer
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // service, reconcile and replay are separate processes
  db.exec(SCHEMA);
  return db;
}
