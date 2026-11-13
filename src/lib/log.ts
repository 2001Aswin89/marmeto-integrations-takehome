export type Level = 'info' | 'warn' | 'error';

/** One JSON line per event, so logs stay greppable by orderId / webhookId. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_LEVEL === 'silent') return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}
