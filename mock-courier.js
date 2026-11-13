// Mock courier API for the Marmeto take-home.
//
// Required behaviour (unchanged):
//   POST /shipments { reference, address, items } -> 201 { shipmentId, reference }
//   ~20% -> 500, ~10% -> 429 with Retry-After: 2, ~10% -> creates the shipment, then hangs 10s
//   The same reference posted twice creates two shipments (not idempotent).
//   GET /shipments?reference=<orderId> -> list of shipments for that reference
//
// Improvements:
//   - createMockCourier(options) is exported so tests run it in-process on a random port.
//   - Deterministic outcomes: `x-mock-force` header, a scripted queue (tests), or --force / MOCK_FORCE.
//   - POST /__reset clears state; GET /__shipments lists everything (handy in demos).
//   - One log line per request, so demos are easy to follow.
//
// Run: node mock-courier.js [--force ok|500|429|hang] [--port 4000]

import express from 'express';
import { pathToFileURL } from 'node:url';

export const MODES = ['ok', '500', '429', 'hang'];
export const DEFAULT_RATES = { error500: 0.2, rateLimit: 0.1, hang: 0.1 };

/**
 * @param {{
 *   rates?: { error500: number, rateLimit: number, hang: number },
 *   hangMs?: number,
 *   retryAfterSec?: number,
 *   force?: string | null,
 *   random?: () => number,
 *   log?: boolean,
 * }} [options]
 */
export function createMockCourier(options = {}) {
  const {
    rates = DEFAULT_RATES,
    hangMs = 10_000,
    retryAfterSec = 2,
    force = null,
    random = Math.random,
    log = true,
  } = options;
  if (force !== null && !MODES.includes(force)) {
    throw new Error(`force must be one of ${MODES.join(', ')}`);
  }

  /** @type {{ shipmentId: string, reference: string, address: unknown, items: unknown, createdAt: string }[]} */
  const store = [];
  /** @type {{ method: string, reference: string | null, outcome: string, shipmentId?: string }[]} */
  const requests = [];
  /** @type {{ post: string[], get: string[] }} */
  const queue = { post: [], get: [] };
  /** @type {Set<NodeJS.Timeout>} */
  const timers = new Set();
  let seq = 0;

  /** @param {string} line */
  const say = (line) => {
    if (log) console.log(`[mock-courier] ${line}`);
  };

  /** @param {import('express').Request} req */
  function pickPostOutcome(req) {
    const header = req.get('x-mock-force');
    if (header && MODES.includes(header)) return header;
    if (queue.post.length > 0) return /** @type {string} */ (queue.post.shift());
    if (force) return force;
    const r = random();
    if (r < rates.error500) return '500';
    if (r < rates.error500 + rates.rateLimit) return '429';
    if (r < rates.error500 + rates.rateLimit + rates.hang) return 'hang';
    return 'ok';
  }

  /**
   * @param {import('express').Response} res
   * @param {() => void} send
   */
  function later(res, send) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      // The client usually gave up long ago; only answer if the socket is still open.
      if (!res.headersSent && !res.socket?.destroyed) send();
    }, hangMs);
    timers.add(timer);
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/shipments', (req, res) => {
    const { reference, address, items } = req.body ?? {};
    if (typeof reference !== 'string' || reference === '') {
      requests.push({ method: 'POST', reference: null, outcome: '400' });
      say('POST /shipments -> 400 (missing reference)');
      res.status(400).json({ error: 'reference is required' });
      return;
    }

    const outcome = pickPostOutcome(req);
    if (outcome === '500') {
      requests.push({ method: 'POST', reference, outcome });
      say(`POST /shipments ref=${reference} -> 500`);
      res.status(500).json({ error: 'internal courier error' });
      return;
    }
    if (outcome === '429') {
      requests.push({ method: 'POST', reference, outcome });
      say(`POST /shipments ref=${reference} -> 429 (Retry-After: ${retryAfterSec})`);
      res.set('Retry-After', String(retryAfterSec)).status(429).json({ error: 'rate limited' });
      return;
    }

    // 'ok' and 'hang' both create the shipment first. That is the whole point of 'hang'.
    const shipment = {
      shipmentId: `shp_${++seq}`,
      reference,
      address: address ?? null,
      items: items ?? [],
      createdAt: new Date().toISOString(),
    };
    store.push(shipment);
    requests.push({ method: 'POST', reference, outcome, shipmentId: shipment.shipmentId });
    const body = { shipmentId: shipment.shipmentId, reference };

    if (outcome === 'hang') {
      say(`POST /shipments ref=${reference} -> hang ${hangMs}ms (created ${shipment.shipmentId})`);
      later(res, () => res.status(201).json(body));
      return;
    }
    say(`POST /shipments ref=${reference} -> 201 (created ${shipment.shipmentId})`);
    res.status(201).json(body);
  });

  app.get('/shipments', (req, res) => {
    const reference = typeof req.query.reference === 'string' ? req.query.reference : '';
    if (reference === '') {
      requests.push({ method: 'GET', reference: null, outcome: '400' });
      res.status(400).json({ error: 'reference query parameter is required' });
      return;
    }
    const outcome = queue.get.shift() ?? 'ok';
    requests.push({ method: 'GET', reference, outcome });
    if (outcome === '500') {
      say(`GET /shipments ref=${reference} -> 500`);
      res.status(500).json({ error: 'internal courier error' });
      return;
    }
    if (outcome === '429') {
      say(`GET /shipments ref=${reference} -> 429`);
      res.set('Retry-After', String(retryAfterSec)).status(429).json({ error: 'rate limited' });
      return;
    }
    const found = store.filter((s) => s.reference === reference);
    if (outcome === 'hang') {
      say(`GET /shipments ref=${reference} -> hang ${hangMs}ms`);
      later(res, () => res.json(found));
      return;
    }
    say(`GET /shipments ref=${reference} -> 200 (${found.length} found)`);
    res.json(found);
  });

  app.get('/__shipments', (_req, res) => {
    res.json(store);
  });

  app.post('/__reset', (_req, res) => {
    reset();
    res.status(204).end();
  });

  function reset() {
    store.length = 0;
    requests.length = 0;
    queue.post.length = 0;
    queue.get.length = 0;
    seq = 0;
  }

  /**
   * Queue deterministic outcomes. An array scripts POST /shipments; an object can script both.
   * @param {string[] | { post?: string[], get?: string[] }} outcomes
   */
  function script(outcomes) {
    const { post = [], get = [] } = Array.isArray(outcomes) ? { post: outcomes } : outcomes;
    for (const o of [...post, ...get]) {
      if (!MODES.includes(o)) throw new Error(`unknown outcome "${o}"`);
    }
    queue.post.push(...post);
    queue.get.push(...get);
  }

  /** @param {number} [port] */
  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, () => {
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        resolve({
          port: actualPort,
          url: `http://127.0.0.1:${actualPort}`,
          /** @returns {Promise<void>} */
          close: () =>
            new Promise((done) => {
              for (const t of timers) clearTimeout(t);
              timers.clear();
              server.closeAllConnections();
              server.close(() => done());
            }),
        });
      });
      server.on('error', reject);
    });
  }

  return { app, store, requests, script, reset, listen };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=');
    if (key === '--force' || key === '--port') args[key.slice(2)] = inline ?? argv[++i];
  }
  return args;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const dotenv = await import('dotenv');
  dotenv.config({ quiet: true });
  const args = parseArgs(process.argv.slice(2));
  const force = args.force ?? process.env.MOCK_FORCE ?? null;
  const port = Number(args.port ?? process.env.MOCK_COURIER_PORT ?? 4000);
  const courier = createMockCourier({ force });
  const { port: actualPort } = await courier.listen(port);
  console.log(
    `[mock-courier] listening on http://localhost:${actualPort}` +
      (force ? ` (forced outcome: ${force})` : ' (random: 20% 500, 10% 429, 10% create-then-hang)'),
  );
}
