import { createApp } from './app.js';
import { loadConfig, usesDefaultSecret } from './config.js';
import { openDb } from './db.js';
import { log } from './lib/log.js';

const config = loadConfig();
if (usesDefaultSecret(config)) {
  log('warn', 'config.default_secret', { hint: 'set WEBHOOK_SECRET in .env for anything but local testing' });
}

const db = openDb(config.dbPath);
const app = createApp({ config, db });
const server = app.listen(config.port, () => {
  log('info', 'service.listening', { url: `http://localhost:${config.port}`, db: config.dbPath });
});

function shutdown(signal: string) {
  log('info', 'service.stopping', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
