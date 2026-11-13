import express, { type ErrorRequestHandler } from 'express';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ordersRouter } from './http/orders.js';
import { webhookRouter } from './http/webhook.js';
import { log } from './lib/log.js';

export interface AppDeps {
  config: Config;
  db: Db;
  now?: () => number;
}

/** Builds the HTTP app from its dependencies, so tests can run it without a real port. */
export function createApp({ config, db, now = Date.now }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  // Deliberately no global body parser: the webhook route needs the raw bytes.
  app.use(webhookRouter({ config, db, now }));
  app.use(ordersRouter({ db }));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = Number(err?.status ?? err?.statusCode ?? 500);
    if (status >= 500) log('error', 'http.error', { error: String(err?.stack ?? err) });
    res.status(status).json({ error: status >= 500 ? 'internal error' : String(err.message) });
  };
  app.use(onError);

  return app;
}
