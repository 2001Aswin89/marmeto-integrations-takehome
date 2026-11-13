import { parseRetryAfter } from './lib/backoff.js';

export interface Shipment {
  shipmentId: string;
  reference: string;
}

export interface ShipmentRequest {
  reference: string;
  address: Record<string, unknown>;
  items: { sku: string | null; quantity: number }[];
}

// Typed errors: the worker decides what to do by error class, never by parsing messages.

/** 429: the courier is healthy and asking us to slow down. */
export class RateLimitedError extends Error {
  readonly kind = 'rate_limited' as const;
  constructor(readonly retryAfterMs: number) {
    super(`courier rate limited, retry after ${retryAfterMs}ms`);
  }
}

export type RetryableReason = 'server_error' | 'timeout' | 'network' | 'bad_response' | 'unknown';

/** 5xx, timeout, network failure: worth retrying. A timeout means "unknown", not "failed". */
export class RetryableError extends Error {
  readonly kind = 'retryable' as const;
  constructor(
    readonly reason: RetryableReason,
    readonly status?: number,
  ) {
    super(`courier ${reason}${status ? ` (${status})` : ''}`);
  }
}

/** Other 4xx, or a payload we can't map: retrying won't help. */
export class PermanentError extends Error {
  readonly kind = 'permanent' as const;
  constructor(readonly reason: string) {
    super(`courier permanent error: ${reason}`);
  }
}

export interface CourierClient {
  /** GET /shipments?reference= : what the courier already has for this order. */
  find(reference: string): Promise<Shipment[]>;
  /** POST /shipments : NOT idempotent on the courier side. Only the worker calls this. */
  create(request: ShipmentRequest): Promise<Shipment>;
}

export interface CourierOptions {
  baseUrl: string;
  timeoutMs: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const isAbort = (err: unknown) =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

const isShipment = (value: unknown): value is Shipment =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Shipment).shipmentId === 'string' &&
  typeof (value as Shipment).reference === 'string';

export function createCourierClient({
  baseUrl,
  timeoutMs,
  now = Date.now,
  fetchImpl = fetch,
}: CourierOptions): CourierClient {
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    // One timeout covers the whole exchange, including reading the body.
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        signal,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new RetryableError(isAbort(err) ? 'timeout' : 'network');
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {}); // free the socket; we don't need the error body
      if (res.status === 429) throw new RateLimitedError(parseRetryAfter(res.headers.get('retry-after'), now()));
      if (res.status >= 500) throw new RetryableError('server_error', res.status);
      throw new PermanentError(`http_${res.status}`);
    }

    try {
      return await res.json();
    } catch (err) {
      throw new RetryableError(isAbort(err) ? 'timeout' : 'bad_response');
    }
  }

  return {
    async find(reference) {
      const data = await call('GET', `/shipments?reference=${encodeURIComponent(reference)}`);
      if (!Array.isArray(data) || !data.every(isShipment)) throw new RetryableError('bad_response');
      return data;
    },
    async create(request) {
      const data = await call('POST', '/shipments', request);
      if (!isShipment(data)) throw new RetryableError('bad_response');
      return data;
    },
  };
}

/**
 * Maps a stored orders/create payload to the courier body. Throws PermanentError('invalid_payload')
 * when the order can't be shipped as-is (no address, no items), so it gets parked and is visible.
 */
export function toShipmentRequest(orderId: string, payloadText: string): ShipmentRequest {
  const invalid = () => new PermanentError('invalid_payload');
  let payload: { shipping_address?: unknown; line_items?: unknown };
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw invalid();
  }

  const address = payload.shipping_address;
  if (typeof address !== 'object' || address === null || Array.isArray(address)) throw invalid();

  const lineItems = payload.line_items;
  if (!Array.isArray(lineItems) || lineItems.length === 0) throw invalid();
  const items = lineItems.map((item: { sku?: unknown; quantity?: unknown }) => {
    if (!Number.isInteger(item?.quantity) || (item.quantity as number) <= 0) throw invalid();
    return { sku: typeof item.sku === 'string' ? item.sku : null, quantity: item.quantity as number };
  });

  return { reference: orderId, address: address as Record<string, unknown>, items };
}
