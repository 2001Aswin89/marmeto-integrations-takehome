# Marmeto take-home: orders/create webhook → courier shipment

A small Node.js + TypeScript service that receives a store's signed `orders/create` webhook, records the order, and creates a shipment with an unreliable courier **exactly once**. That holds even when the webhook arrives twice and when the courier creates the shipment but then times out.

```
store ──signed POST──▶ /webhooks/orders-create ──1 transaction──▶ SQLite (orders + jobs)
                         (verify HMAC, reply 200)                      │
                                                                        ▼
                                              worker: GET /shipments?reference=  (already there? adopt it)
                                                      POST /shipments            (only if not)
                                                      retry / backoff / 429 pause / park
                                                                        ▲
                         npm run reconcile ─── GET only: adopt or requeue ┘     npm run failed / replay
```

---

## Quick start

Needs Node.js 20+ (built and tested on Node 22, Windows 11).

```bash
npm install
npm start
```

`npm start` runs the mock courier (port 4000) and the service (port 3000) together. In Windows PowerShell 5.1, use `npm install; npm start`, since `&&` isn't supported there. Every setting has a default, so no `.env` is needed. To change anything, copy `.env.example` to `.env`.

In a second terminal:

```bash
npm run send-webhook
```

```
order 1794602304256 -> http://localhost:3000
1. original delivery                 -> 200 {"ok":true,"duplicate":false}
2. same delivery again (same id)     -> 200 {"ok":true,"duplicate":"webhook"}
3. same order, new webhook id        -> 200 {"ok":true,"duplicate":"order"}
```

The service log then shows the worker checking the courier, then creating (or retrying through the mock's random 500s and 429s):

```
[courier] [mock-courier] GET /shipments ref=1794602304256 -> 200 (0 found)
[courier] [mock-courier] POST /shipments ref=1794602304256 -> 201 (created shp_1)
[service] {"level":"info","msg":"shipment.created","orderId":"1794602304256","shipmentId":"shp_1",...}
```

Check an order with `curl http://localhost:3000/orders/<orderId>`. `send-webhook` takes `--order <id>`, `--once`, and `--bad-signature` (shows the 401).

### The same with curl

The signature is computed over the exact file bytes, and `--data-binary` sends those same bytes.

PowerShell:

```powershell
$sig = node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHmac('sha256',process.env.WEBHOOK_SECRET||'dev-secret-change-me').update(f.readFileSync('fixtures/order.json')).digest('base64'))"
curl.exe -s -X POST http://localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Webhook-Id: demo-1" -H "X-Shop-Hmac-Sha256: $sig" --data-binary "@fixtures/order.json"
# run the curl line again: same X-Shop-Webhook-Id -> {"ok":true,"duplicate":"webhook"}
```

bash:

```bash
SIG=$(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHmac('sha256',process.env.WEBHOOK_SECRET||'dev-secret-change-me').update(f.readFileSync('fixtures/order.json')).digest('base64'))")
curl -s -X POST http://localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Webhook-Id: demo-1" -H "X-Shop-Hmac-Sha256: $SIG" --data-binary @fixtures/order.json
# run the curl line again: same X-Shop-Webhook-Id -> {"ok":true,"duplicate":"webhook"}
```

---

## Seeing the failure handling

The mock courier takes `--force ok|500|429|hang`. These npm scripts use it, so there's no shell-specific env syntax.

**The courier creates the shipment, then times out.** This is the case that matters most:

```bash
npm run demo:hang                         # every POST creates the shipment, then hangs 10s
npm run send-webhook -- --once            # (second terminal)
```
```
GET  /shipments ref=7001 -> 200 (0 found)
POST /shipments ref=7001 -> hang 10000ms (created shp_1)
job.retry_scheduled  reason=timeout attempts=1      # our 5s timeout fired; "unknown", not "failed"
GET  /shipments ref=7001 -> 200 (1 found)
shipment.adopted     shipmentId=shp_1               # adopted; no second POST
```

**The courier is down → the job is parked → replay it:**

```bash
npm run demo:500                          # every POST returns 500
npm run send-webhook -- --once            # wait ~15s: 5 attempts with 1s/2s/4s/8s backoff
npm run failed                            # the parked job, its last error and counters
# stop demo:500, then start the normal stack again: npm start
npm run replay -- <orderId>               # queued again; the worker ships it
```

**Reconciliation:**

```bash
npm run reconcile -- --min-age 0          # default min age is 2 minutes
```
```
┌─────────┬─────────┬────────────┬────────────────────┐
│ (index) │ orderId │ action     │ note               │
├─────────┼─────────┼────────────┼────────────────────┤
│ 0       │ '5001'  │ 'requeued' │ 'was server_error' │
└─────────┴─────────┴────────────┴────────────────────┘
checked 1: adopted 0, requeued 1, needs attention 0, in flight 0, errored 0
```

---

## Design decisions and why

### 1. A DB-backed queue (a `jobs` table in the same SQLite file)

| | **DB table (chosen)** | BullMQ / Redis | In-process array |
|---|---|---|---|
| Order and job saved atomically | ✅ one transaction | ❌ two systems: DB write, then Redis write | ❌ |
| Survives a restart | ✅ | ✅ | ❌ jobs lost |
| Extra infrastructure | none | Redis | none |
| Several workers / scale-out | ❌ single writer, polling | ✅ | ❌ |
| Visibility | plain SQL | dashboard / API | none |

The webhook handler writes the webhook event, the order and its job in **one transaction** before replying 200. If the process dies right after the reply, the job still exists. With BullMQ, "save the order, then enqueue" is two writes to two systems, so a crash between them leaves an acknowledged order with no job (the dual-write/outbox problem). It also needs Redis, so "one command to run" becomes "install Redis first". The price is polling (every 500ms) and a single worker process. That's fine at this size, and the next step is below.

### 2. Two layers of webhook idempotency

- `webhook_events.webhook_id` is the primary key. The same `X-Shop-Webhook-Id` delivered twice gives `duplicate: "webhook"`.
- `orders.order_id` is the primary key and `jobs.order_id` is unique. The same order under a new webhook ID gives `duplicate: "order"`. This also covers a missing `X-Shop-Webhook-Id` header, which is accepted with a warning.
- Duplicates get **200**, because any non-2xx makes the store redeliver. Order IDs are normalised to strings (`1001` and `"1001"` are the same order).

### 3. Check before create: the core fix

The courier isn't idempotent, and a timeout doesn't mean the request failed. So **before every `POST /shipments` the worker calls `GET /shipments?reference=<orderId>`**, and if a shipment exists it adopts it instead of posting. The same check covers a worker that crashed after a successful POST but before saving the result. A failed GET is handled like any other failure. **It never falls through to a POST.**

If the courier returns several shipments for one order (it can't happen through this service, but the courier allows it), the earliest is kept, the count is stored in `orders.duplicate_shipments`, and a warning is logged. In production that should page someone.

**The remaining risk, stated honestly:** a real courier could still be committing the shipment when our GET returns empty. The mock creates the shipment *before* it hangs, so it can't show this. The 5s timeout plus backoff keep the window small. Only an idempotency key on the courier's side closes it completely, and it's the first thing I'd ask the courier for.

### 4. A retry policy per error type

| Failure | What happens | Why |
|---|---|---|
| **429** | Requeue at `Retry-After` (seconds or HTTP date, clamped to 60s). **Not** counted as a failed attempt. The worker pauses **all** courier calls until then. Parked after `MAX_RATE_LIMIT_HITS` (20). | The courier is healthy and asking us to slow down, and the limit is per account, not per order. The cap stops a 429 storm from looping forever. |
| **5xx, timeout, network** | `attempts + 1`, exponential backoff with jitter (1s, 2s, 4s, 8s … cap 30s). Parked after `MAX_ATTEMPTS` (5). | Transient. A timeout means "unknown", and the next attempt's GET check resolves it. |
| **Other 4xx, unshippable payload** | Parked immediately (`http_400`, `invalid_payload`). | Retrying won't help. A human needs to look. |

### 5. Leases, not locks

A claimed job holds `locked_until = now + LEASE_MS`. Claiming is one `UPDATE … WHERE id = (SELECT …) RETURNING *` statement, so two claimers can't get the same job. If the worker dies, the job is claimable again when the lease expires, and that reclaim **counts as an attempt**. So a payload that crashes the worker ends up parked instead of looping. Config refuses a `LEASE_MS` shorter than 3 × `COURIER_TIMEOUT_MS`, so a live job (at most two courier calls) can never be reclaimed under itself.

### 6. Parking is visible and replayable

A parked job is `jobs.status = 'dead'` (with attempts, counters and `last_error`), and its order is `failed`. `npm run failed` lists them. `npm run replay -- <orderId>` gives one a fresh start. Replay only touches a job that is still `dead`, and it's safe because the worker checks the courier before creating.

### 7. Reconciliation only adopts or requeues; it never POSTs

`npm run reconcile` looks at orders with no confirmed shipment that are older than 2 minutes, **skipping jobs under a live lease** so it never races the worker, and asks the courier first:

| Courier has it? | Job | Action |
|---|---|---|
| yes | any | **adopt** (this is the "created, then timed out" recovery) |
| no | parked, transient error, requeued < 3 times | **requeue** for the worker |
| no | parked, permanent error, or already requeued 3 times | **needs attention** (left for a human replay) |
| no | queued (waiting out a backoff) | **in flight**, left alone |
| GET failed | — | **errored**, skipped (a 429 stops the run early) |

Only one code path creates shipments: the worker, which always checks first. Every reconcile write is a conditional `UPDATE`, so it can't overwrite a decision the worker made meanwhile. Running it twice is harmless.

### 8. Small things on purpose

- The HMAC is checked over the **raw bytes**. There's no global JSON parser, only `express.raw()` on the webhook route. The compare uses `crypto.timingSafeEqual` after a length check (it throws on unequal lengths).
- A request with no body or no content type gets 401, not a 500.
- An order ID that is a number above 2^53 is rejected with 400. `JSON.parse` has already rounded it, and silently keying the wrong order is worse than refusing it.
- SQLite runs with WAL and `busy_timeout`, because the service, `reconcile` and `replay` are separate processes sharing one file.
- The worker runs in the service's process for simplicity, but only shares the DB, so it can move to its own process unchanged.

---

## Assumptions

1. **First payload wins** for an order ID. A later `orders/create` for the same ID is acknowledged and ignored (edits would arrive as `orders/updated`).
2. **"Reconciliation safely re-tries"** means requeue with a bounded budget, as in the table above. Permanent failures are not auto-retried, so parking stays meaningful.
3. Any 4xx except 429 is permanent.
4. A missing `X-Shop-Webhook-Id` is accepted with a warning, and idempotency then rests on the order ID.
5. An order without a shipping address or line items (for example digital goods) is parked as `invalid_payload`. In a real integration it would be skipped by rule, but parking keeps it visible.

## Data model

| Table | Holds |
|---|---|
| `webhook_events` | every delivery we accepted, keyed by `X-Shop-Webhook-Id` |
| `orders` | the raw payload, `status` (`pending` / `shipped` / `failed`), `shipment_id`, `duplicate_shipments` |
| `jobs` | one per order: `status` (`queued` / `in_progress` / `done` / `dead`), `attempts`, `rate_limit_hits`, `reconcile_requeues`, `run_at`, `locked_until`, `last_error` |

The invariant is that an order is `shipped` exactly when its job is `done` (always written in one transaction).

---

## Tests

```bash
npm test          # 61 tests, ~5s, Node's built-in test runner; mock courier runs in-process on a random port
npm run typecheck
```

The worker is driven one job at a time with an injected clock, so no test waits for a real backoff or `Retry-After`. The only real waits are small HTTP timeouts (200ms against a 600ms hang).

| Test | Protects against |
|---|---|
| T0 mock courier | the mock not doing what the brief says (e.g. "hang" must create the shipment *before* hanging) |
| T1 signature | tampered body, wrong secret, missing/garbage header → 401, and nothing stored |
| T2 raw bytes | a parser re-serialising the body before the HMAC check |
| T3 / T4 idempotency | the same webhook twice, or the same order under a new webhook ID (number vs string), creating a second job |
| **T5 create-then-timeout** | **a second shipment after the courier timed out but had created it: exactly 1 shipment** |
| T6 429 | not respecting `Retry-After`, counting 429s as failures, 429 storms looping forever |
| T7 5xx → park → replay | retrying forever; replay causing a duplicate |
| T8 / T13 backoff, Retry-After | wrong delays, missing cap, `Date.parse('-5')` reading as a real date (found by this test) |
| T9 reconciliation | reconcile POSTing, racing a live lease, re-running unsafely, auto-retrying permanent failures |
| T10 fast webhook | a courier call creeping into the request path |
| T11 failed GET | a failed check falling through to a POST |
| T12 leases | a crashed worker's job being stuck forever, or a poison job looping; a crash after POST creating a duplicate |
| T14 courier client | HTTP status → error type mapping, timeouts, network errors |

---

## What I'd do next with another day

1. **Several workers:** move to Postgres and claim with `SELECT … FOR UPDATE SKIP LOCKED`, or keep the transactional outbox table and relay it into BullMQ. The in-memory 429 pause would become a shared record (or a Redis token bucket).
2. **Run reconciliation on a schedule** (cron, or a `setInterval` in the service), and alert on `needs_attention`.
3. **Metrics and alerts:** parked jobs, `duplicate_shipments > 0`, 429 rate, time from webhook to shipment.
4. **Webhook replay protection:** check a timestamp header against a time window, and prune old `webhook_events`.
5. **Ask the courier for an idempotency key** (`Idempotency-Key: <orderId>`). That's the only full fix for the remaining race.
6. **Auth** on `GET /orders/:id`, and admin endpoints for failed/replay.
7. **A per-attempt audit table** (each courier call with its status and latency), for support questions like "why did this ship late?".

## What I deliberately left out

| Left out | Why |
|---|---|
| Docker / docker-compose, deployment | `npm install && npm start` already runs everything, with no external services |
| A UI | not being judged; the CLI and `GET /orders/:id` cover visibility |
| Auth on the read-only and CLI tools | local demo; listed above as a next step |
| Multiple workers | needs a different database to do safely (see "next") |
| Full Shopify payload model or schema validation | only the fields the shipment needs are validated |
| Persisting the mock courier's state | the mock forgets its shipments on restart, which is fine for a demo, but don't restart only the mock mid-`demo:hang` and expect reconcile to find old shipments |

### Notes on tooling

- **SQLite via `better-sqlite3`:** synchronous, real transactions, `RETURNING`, and prebuilt binaries for Windows.
- **Express 5** (it forwards errors from async handlers itself).
- **Node's built-in `node:test`** instead of vitest or jest: one less dependency, and plenty for these tests. TypeScript runs through `tsx`, so there's no build step.

## Repository layout

```
mock-courier.js          the mock courier (required name), importable for tests
src/server.ts            entry: HTTP server + worker + graceful shutdown
src/app.ts               createApp() (no global body parser)
src/http/webhook.ts      POST /webhooks/orders-create
src/http/orders.ts       GET /orders/:orderId
src/lib/hmac.ts          sign / verify (timing-safe)
src/lib/backoff.ts       computeBackoff / parseRetryAfter
src/courier.ts           courier client, typed errors, payload → shipment mapping
src/db.ts                schema + pragmas
src/repo.ts              every SQL statement: ingest, claim, ship, retry, park, replay, adopt
src/worker.ts            processJob (the decision logic), processNextJob, startWorker
src/reconcile.ts         one reconciliation pass
src/scripts/*            send-webhook, reconcile, failed/replay
tests/*                  T0–T14
```

## AI assistance

Built with Claude Code as a pair programmer. I made the design decisions, reviewed every change, and can explain every line.

## Time spent

The build, from first commit to the end of reconciliation, took about 30 minutes of pairing (see the commit timestamps). The README and final checks took a further 30 minutes or so. Planning the design and reviewing the plan before the first commit are not included in those numbers.
