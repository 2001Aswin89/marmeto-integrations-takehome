// Pretends to be the merchant's store: sends a correctly signed orders/create webhook,
// then the same delivery again, then the same order under a new webhook id.
//
//   npm run send-webhook                     fresh order id, all three requests
//   npm run send-webhook -- --order 1001     a specific order id
//   npm run send-webhook -- --once           only the first request
//   npm run send-webhook -- --bad-signature  shows the 401
//   npm run send-webhook -- --url http://localhost:3000

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { sign } from '../lib/hmac.js';

const { values: args } = parseArgs({
  options: {
    order: { type: 'string' },
    once: { type: 'boolean', default: false },
    'bad-signature': { type: 'boolean', default: false },
    url: { type: 'string' },
  },
});

const config = loadConfig();
const baseUrl = (args.url ?? `http://localhost:${config.port}`).replace(/\/+$/, '');
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/order.json', import.meta.url), 'utf8'));

// A fresh id per run unless one is given, so repeated runs create new orders.
const orderId = args.order ?? String(Date.now());
const id = /^\d+$/.test(orderId) ? Number(orderId) : orderId;
const body = JSON.stringify({ ...fixture, id, name: `#${orderId}` });

async function send(label: string, webhookId: string, signature: string) {
  const res = await fetch(`${baseUrl}/webhooks/orders-create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shop-Topic': 'orders/create',
      'X-Shop-Webhook-Id': webhookId,
      'X-Shop-Hmac-Sha256': signature,
    },
    body, // the exact bytes that were signed
  });
  console.log(`${label.padEnd(36)} -> ${res.status} ${await res.text()}`);
}

const signature = args['bad-signature'] ? sign('wrong-secret', body) : sign(config.webhookSecret, body);
const firstWebhookId = randomUUID();

console.log(`order ${orderId} -> ${baseUrl}`);
try {
  await send('1. original delivery', firstWebhookId, signature);
  if (!args.once && !args['bad-signature']) {
    await send('2. same delivery again (same id)', firstWebhookId, signature);
    await send('3. same order, new webhook id', randomUUID(), signature);
  }
} catch (err) {
  console.error(`Could not reach ${baseUrl}. Is the service running (npm start)?`);
  console.error(String((err as Error).cause ?? err));
  process.exitCode = 1;
}
