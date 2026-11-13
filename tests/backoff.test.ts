import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoff, parseRetryAfter } from '../src/lib/backoff.js';

describe('T8 computeBackoff', () => {
  test('doubles per attempt from 1s', () => {
    const noJitter = () => 0;
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => computeBackoff(n, noJitter)),
      [1000, 2000, 4000, 8000, 16000],
    );
  });

  test('is capped at 30s', () => {
    assert.equal(computeBackoff(6, () => 0), 30_000);
    assert.equal(computeBackoff(50, () => 0), 30_000);
  });

  test('adds 0–249ms of jitter from the injected random', () => {
    assert.equal(computeBackoff(1, () => 0.5), 1125);
    assert.equal(computeBackoff(1, () => 0.999999), 1249);
  });
});

describe('T13 parseRetryAfter', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');

  test('delay-seconds', () => {
    assert.equal(parseRetryAfter('2', now), 2000);
    assert.equal(parseRetryAfter(' 0 ', now), 0);
  });

  test('HTTP date', () => {
    assert.equal(parseRetryAfter('Fri, 13 Nov 2026 10:00:05 GMT', now), 5000);
    assert.equal(parseRetryAfter('Fri, 13 Nov 2026 09:00:00 GMT', now), 0, 'a date in the past means now');
  });

  test('missing or garbage falls back to 1s', () => {
    assert.equal(parseRetryAfter(null, now), 1000);
    assert.equal(parseRetryAfter('', now), 1000);
    assert.equal(parseRetryAfter('soon', now), 1000);
    assert.equal(parseRetryAfter('-5', now), 1000);
  });

  test('huge values are clamped to 60s', () => {
    assert.equal(parseRetryAfter('86400', now), 60_000);
  });
});
