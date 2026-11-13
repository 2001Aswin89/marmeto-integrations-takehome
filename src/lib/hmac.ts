import { createHmac, timingSafeEqual } from 'node:crypto';

/** base64(HMAC-SHA256(secret, body)) — what the store puts in X-Shop-Hmac-Sha256. */
export function sign(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

/**
 * Constant-time check of the signature header against the exact bytes received.
 * timingSafeEqual throws on a length mismatch, so lengths are compared first
 * (the length of a base64 SHA-256 digest is public anyway: always 44 chars).
 */
export function verify(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(sign(secret, rawBody), 'utf8');
  const received = Buffer.from(header.trim(), 'utf8');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
