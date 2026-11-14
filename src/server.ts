import { createApp } from './app.js';
import { loadConfig, usesDefaultSecret } from './config.js';
import { createCourierClient } from './courier.js';
import { openDb } from './db.js';
import { log } from './lib/log.js';
import { createShutdown } from './shutdown.js';
import { startWorker } from './worker.js';

const config = loadConfig();
if (usesDefaultSecret(config)) {
  log('warn', 'config.default_secret', { hint: 'set WEBHOOK_SECRET in .env for anything but local testing' });
}

const db = openDb(config.dbPath);
const courier = createCourierClient({ baseUrl: config.courierBaseUrl, timeoutMs: config.courierTimeoutMs });
const app = createApp({ config, db });
const server = app.listen(config.port, () => {
  log('info', 'service.listening', {
    url: `http://localhost:${config.port}`,
    courier: config.courierBaseUrl,
    db: config.dbPath,
  });
});

// Same process for simplicity; the worker only shares the DB, so it can move to its own process later.
const worker = startWorker({ db, courier, config, now: Date.now });

const shutdown = createShutdown({
  closeHttp: () => {
    server.close();
    server.closeIdleConnections();
  },
  stopWorker: () => worker.stop(),
  closeDb: () => db.close(),
  exit: (code) => process.exit(code),
});
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
