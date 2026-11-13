import express, { Router } from 'express';
import type { Config } from '../config.js';
import { verify } from '../lib/hmac.js';
import { log } from '../lib/log.js';

export interface WebhookDeps {
  config: Config;
}

/** Returns the order id as a string, or null if it is missing or unusable as a key. */
export function parseOrderId(id: unknown): string | null {
  // Unsafe integers have already been rounded by JSON.parse; keying on them would be wrong.
  if (typeof id === 'number') return Number.isSafeInteger(id) ? String(id) : null;
  if (typeof id === 'string' && id.trim() !== '') return id.trim();
  return null;
}

export function webhookRouter({ config }: WebhookDeps): Router {
  const router = Router();

  router.post(
    '/webhooks/orders-create',
    // Raw bytes on this route only: the HMAC is over the exact body received.
    express.raw({ type: () => true, limit: '1mb' }),
    (req, res) => {
      const started = Date.now();
      // With no body (or nothing for the parser to read) req.body is not a Buffer.
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (!verify(config.webhookSecret, rawBody, req.get('X-Shop-Hmac-Sha256'))) {
        log('warn', 'webhook.rejected', { reason: 'invalid signature' });
        res.status(401).json({ error: 'invalid signature' });
        return;
      }

      let payload: { id?: unknown };
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'invalid json' });
        return;
      }

      const orderId = parseOrderId(payload?.id);
      if (orderId === null) {
        res.status(400).json({ error: 'invalid order id' });
        return;
      }

      const webhookId = req.get('X-Shop-Webhook-Id')?.trim() || null;
      if (webhookId === null) {
        log('warn', 'webhook.missing_webhook_id', { orderId });
      }

      log('info', 'webhook.received', { orderId, webhookId, ms: Date.now() - started });
      res.status(200).json({ ok: true });
    },
  );

  return router;
}
