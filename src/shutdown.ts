import { log } from './lib/log.js';

export interface ShutdownDeps {
  closeHttp: () => void;
  stopWorker: () => Promise<void>;
  closeDb: () => void;
  exit: (code: number) => void;
  now?: () => number;
  /** Repeat signals within this window are echoes of the same Ctrl+C, not a second one. */
  echoWindowMs?: number;
}

/**
 * Builds the SIGINT/SIGTERM handler: stop taking requests, let the in-flight job finish,
 * close the DB, exit 0. A deliberate second Ctrl+C forces the exit.
 *
 * One Ctrl+C often arrives more than once. On macOS/Linux the terminal signals every process
 * in the foreground group and `concurrently` forwards the same SIGINT again; with `-k` it also
 * sends SIGTERM as soon as the mock courier exits. Those echoes land within milliseconds, so
 * they are ignored instead of being treated as "force quit", which would kill the in-flight job.
 */
export function createShutdown({
  closeHttp,
  stopWorker,
  closeDb,
  exit,
  now = Date.now,
  echoWindowMs = 1000,
}: ShutdownDeps) {
  let startedAt: number | null = null;

  return async function onSignal(signal: string): Promise<void> {
    if (startedAt !== null) {
      if (now() - startedAt < echoWindowMs) return; // the same Ctrl+C, delivered twice
      log('warn', 'service.forced_exit', { signal });
      exit(1);
      return;
    }
    startedAt = now();
    log('info', 'service.stopping', { signal, note: 'finishing the in-flight job first (Ctrl+C again to force)' });
    closeHttp();
    await stopWorker();
    closeDb();
    log('info', 'service.stopped');
    exit(0);
  };
}
