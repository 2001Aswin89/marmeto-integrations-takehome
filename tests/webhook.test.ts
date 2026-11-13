import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { sign, verify } from '../src/lib/hmac.js';
import { orderPayload, signedPost, testConfig, TEST_SECRET } from './helpers.js';

const app = createApp({ config: testConfig() });
const body = JSON.stringify(orderPayload(1001));

describe('T1 signature verification', () => {
  test('a valid signature is accepted', async () => {
    const res = await signedPost(app, body);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('a tampered body is rejected with 401', async () => {
    const signature = sign(TEST_SECRET, body);
    const tampered = body.replace('"quantity":2', '"quantity":20');
    const res = await signedPost(app, tampered, { signature });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'invalid signature' });
  });

  test('a signature made with the wrong secret is rejected', async () => {
    const res = await signedPost(app, body, { secret: 'not-the-secret' });
    assert.equal(res.status, 401);
  });

  test('a missing signature header is rejected', async () => {
    const res = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .send(body);
    assert.equal(res.status, 401);
  });

  test('a wrong-length or garbage header is rejected without throwing', async () => {
    // 'A'.repeat(43) + '=' has the same length as a real signature, so it reaches timingSafeEqual.
    for (const signature of ['abc', 'x'.repeat(200), '', 'A'.repeat(43) + '=']) {
      const res = await signedPost(app, body, { signature });
      assert.equal(res.status, 401, `header ${JSON.stringify(signature)}`);
    }
    assert.equal(verify(TEST_SECRET, Buffer.from(body), 'short'), false);
  });

  test('a request with no body and no content type gets 401, not 500', async () => {
    const res = await request(app).post('/webhooks/orders-create').set('X-Shop-Hmac-Sha256', 'abc');
    assert.equal(res.status, 401);
  });
});

describe('T2 the HMAC is over the raw bytes', () => {
  test('odd spacing and unicode still verify, because nothing re-serialises the body', async () => {
    const raw = '{ "id" : 2002,\n  "note": "café ☕ — नमस्ते",   "line_items": [] }';
    const res = await signedPost(app, raw);
    assert.equal(res.status, 200);
  });

  test('a signature over the re-serialised JSON does not match the original bytes', async () => {
    const raw = '{ "id" : 2002,  "note": "café" }';
    const reserialised = JSON.stringify(JSON.parse(raw));
    const res = await signedPost(app, raw, { signature: sign(TEST_SECRET, reserialised) });
    assert.equal(res.status, 401);
  });
});

describe('payload checks after a valid signature', () => {
  test('invalid JSON is a 400', async () => {
    const res = await signedPost(app, '{not json');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'invalid json' });
  });

  test('a missing or unusable order id is a 400', async () => {
    for (const raw of ['{}', '{"id":null}', '{"id":""}', '{"id":1.5}', '{"id":12345678901234567890}']) {
      const res = await signedPost(app, raw);
      assert.equal(res.status, 400, raw);
      assert.deepEqual(res.body, { error: 'invalid order id' });
    }
  });

  test('a string order id is accepted', async () => {
    const res = await signedPost(app, JSON.stringify(orderPayload('ORD-1')));
    assert.equal(res.status, 200);
  });

  test('an oversize body is a 413', async () => {
    const big = JSON.stringify({ id: 1, pad: 'x'.repeat(1_100_000) });
    const res = await signedPost(app, big);
    assert.equal(res.status, 413);
  });
});
