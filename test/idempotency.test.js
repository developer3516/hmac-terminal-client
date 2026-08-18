import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_IDEMPOTENCY,
  TerminalClient,
  buildCanonicalRequest,
  keyFor,
  resolveIdempotencyConfig,
  verifyRequest,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';

/** Replays a scripted sequence, one entry per call, recording each request. */
function sequenceFetch(steps) {
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];

    if (step instanceof Error) throw step;

    return new Response(JSON.stringify({ ok: true }), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  fetchImpl.calls = calls;
  return fetchImpl;
}

const makeClient = (fetchImpl, overrides = {}) =>
  new TerminalClient({
    baseUrl: 'https://api.example.com',
    keyId: KEY_ID,
    secret: SECRET,
    fetch: fetchImpl,
    random: () => 0,
    retry: { minDelayMs: 1, maxDelayMs: 2 },
    ...overrides,
  });

const keysFrom = (fetchImpl, header = 'idempotency-key') =>
  fetchImpl.calls.map((call) => call.init.headers[header]);

describe('resolveIdempotencyConfig', () => {
  it('is off unless asked for', () => {
    assert.equal(resolveIdempotencyConfig(undefined), null);
    assert.equal(resolveIdempotencyConfig(false), null);
    assert.equal(resolveIdempotencyConfig(null), null);
  });

  it('takes the defaults for true', () => {
    const config = resolveIdempotencyConfig(true);

    assert.equal(config.header, 'idempotency-key');
    assert.deepEqual(config.methods, DEFAULT_IDEMPOTENCY.methods);
  });

  it('merges an object over the defaults', () => {
    const config = resolveIdempotencyConfig({ header: 'x-request-key' });

    assert.equal(config.header, 'x-request-key');
    assert.deepEqual(config.methods, DEFAULT_IDEMPOTENCY.methods);
  });
});

describe('keyFor', () => {
  const config = resolveIdempotencyConfig(true);

  it('keys the unsafe methods and leaves the safe ones alone', () => {
    assert.match(keyFor(config, 'POST'), /^[0-9a-f-]{36}$/);
    assert.match(keyFor(config, 'PATCH'), /^[0-9a-f-]{36}$/);
    assert.equal(keyFor(config, 'GET'), null);
    assert.equal(keyFor(config, 'DELETE'), null);
  });

  it('is case-insensitive about the method', () => {
    assert.notEqual(keyFor(config, 'post'), null);
  });

  it('returns a different key each time', () => {
    assert.notEqual(keyFor(config, 'POST'), keyFor(config, 'POST'));
  });

  it('prefers an explicit key, even on a method it would skip', () => {
    // A caller passing one has a reason — usually deduplicating across process
    // restarts from their own job record.
    assert.equal(keyFor(config, 'GET', 'job-42'), 'job-42');
    assert.equal(keyFor(null, 'GET', 'job-42'), 'job-42');
  });

  it('rejects a malformed explicit key rather than sending it', () => {
    assert.throws(() => keyFor(config, 'POST', ''), TypeError);
    assert.throws(() => keyFor(config, 'POST', 42), TypeError);
  });

  it('returns null when disabled', () => {
    assert.equal(keyFor(null, 'POST'), null);
  });
});

describe('TerminalClient — attaching the key', () => {
  it('sends one on a POST when enabled', async () => {
    const fetchImpl = sequenceFetch([{}]);
    await makeClient(fetchImpl, { idempotency: true }).post('/terminals/T-1/capture', { amount: 1250 });

    assert.match(fetchImpl.calls[0].init.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  });

  it('sends none on a GET', async () => {
    const fetchImpl = sequenceFetch([{}]);
    await makeClient(fetchImpl, { idempotency: true }).get('/terminals');

    assert.equal(fetchImpl.calls[0].init.headers['idempotency-key'], undefined);
  });

  it('sends none at all when disabled', async () => {
    const fetchImpl = sequenceFetch([{}]);
    await makeClient(fetchImpl).post('/terminals', { a: 1 });

    assert.equal(fetchImpl.calls[0].init.headers['idempotency-key'], undefined);
  });

  it('uses the caller key verbatim', async () => {
    const fetchImpl = sequenceFetch([{}]);
    await makeClient(fetchImpl, { idempotency: true }).post('/terminals', { a: 1 }, {
      idempotencyKey: 'payout-2026-08-18-0042',
    });

    assert.equal(fetchImpl.calls[0].init.headers['idempotency-key'], 'payout-2026-08-18-0042');
  });

  it('honours a custom header name', async () => {
    const fetchImpl = sequenceFetch([{}]);
    await makeClient(fetchImpl, { idempotency: { header: 'x-request-key' } }).post('/t', { a: 1 });

    assert.match(fetchImpl.calls[0].init.headers['x-request-key'], /^[0-9a-f-]{36}$/);
    assert.equal(fetchImpl.calls[0].init.headers['idempotency-key'], undefined);
  });

  it('gives each logical request its own key', async () => {
    const fetchImpl = sequenceFetch([{}]);
    const client = makeClient(fetchImpl, { idempotency: true });

    await client.post('/t', { a: 1 });
    await client.post('/t', { a: 1 });

    const [first, second] = keysFrom(fetchImpl);
    assert.notEqual(first, second);
  });
});

describe('TerminalClient — the key across retries', () => {
  it('reuses one key for every attempt', async () => {
    // The load-bearing property. A key minted per attempt would look like
    // protection while still letting the server perform the write twice.
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl, { idempotency: true }).post('/terminals/T-1/capture', { amount: 1250 });

    const keys = keysFrom(fetchImpl);
    assert.equal(fetchImpl.calls.length, 3);
    assert.equal(new Set(keys).size, 1, `expected one key, got ${keys.join(', ')}`);
  });

  it('still signs each attempt afresh', async () => {
    // The key is stable across attempts; the signature is not. Both are
    // required, and confusing them breaks one or the other.
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl, { idempotency: true }).post('/t', { a: 1 });

    assert.equal(new Set(keysFrom(fetchImpl)).size, 1);
    assert.equal(new Set(fetchImpl.calls.map((c) => c.init.headers['x-nonce'])).size, 2);
  });

  it('keeps a caller-supplied key stable across attempts too', async () => {
    const fetchImpl = sequenceFetch([{ status: 503 }, { status: 200 }]);

    await makeClient(fetchImpl, { idempotency: true }).post('/t', { a: 1 }, { idempotencyKey: 'job-7' });

    assert.deepEqual(keysFrom(fetchImpl), ['job-7', 'job-7']);
  });
});

describe('TerminalClient — a key makes POST retryable', () => {
  it('retries a POST once it carries a key', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl, { idempotency: true }).post('/terminals/T-1/capture', { amount: 1250 });

    assert.equal(fetchImpl.calls.length, 2);
  });

  it('still refuses without one', async () => {
    // Unchanged behaviour when idempotency is off: replaying a write that may
    // already have succeeded is how a customer gets charged twice.
    const fetchImpl = sequenceFetch([{ status: 500 }]);

    await assert.rejects(makeClient(fetchImpl).post('/terminals/T-1/capture', { amount: 1250 }));
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('retries a GET with or without a key', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl, { idempotency: true }).get('/terminals');
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('lets retry:false override a key', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }]);

    await assert.rejects(
      makeClient(fetchImpl, { idempotency: true }).post('/t', { a: 1 }, { retry: false }),
    );
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('retries a method outside the policy when the caller supplies a key', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl).post('/t', { a: 1 }, { idempotencyKey: 'job-9' });

    assert.equal(fetchImpl.calls.length, 2);
    assert.deepEqual(keysFrom(fetchImpl), ['job-9', 'job-9']);
  });
});

describe('the key is outside the signature', () => {
  it('does not appear in the canonical request', async () => {
    // Worth being explicit about: the scheme signs method, path, query,
    // timestamp, nonce and body — not arbitrary headers. The key is a
    // server-side dedup hint, and replay protection comes from the nonce and
    // timestamp, which are signed.
    const fetchImpl = sequenceFetch([{}]);
    await makeClient(fetchImpl, { idempotency: true }).post('/terminals', { a: 1 });

    const { init } = fetchImpl.calls[0];
    const canonical = buildCanonicalRequest({
      method: 'POST',
      path: '/terminals',
      timestamp: Number(init.headers['x-timestamp']),
      nonce: init.headers['x-nonce'],
      body: '{"a":1}',
    });

    assert.ok(!canonical.includes(init.headers['idempotency-key']));
  });

  it('still verifies server-side with the key present', async () => {
    const fetchImpl = sequenceFetch([{}]);
    await makeClient(fetchImpl, { idempotency: true }).post('/terminals', { a: 1 });

    const result = verifyRequest({
      secret: SECRET,
      headers: fetchImpl.calls[0].init.headers,
      method: 'POST',
      path: '/terminals',
      body: { a: 1 },
    });

    assert.equal(result.valid, true, result.reason ?? '');
  });
});
