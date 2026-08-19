import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HIDDEN_HEADERS,
  REDACTED,
  TerminalClient,
  TRUNCATED_HEADERS,
  redactHeaders,
  redactUrl,
  requestEvent,
  responseEvent,
  truncate,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';
const SIGNATURE = 'a'.repeat(64);

function sequenceFetch(steps) {
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];

    if (step instanceof Error) throw step;

    return new Response(JSON.stringify({ ok: true }), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
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

describe('truncate', () => {
  it('shows a prefix and the original length', () => {
    assert.equal(truncate(SIGNATURE), 'aaaaaaaa…(64)');
  });

  it('hides a value too short to truncate usefully', () => {
    assert.equal(truncate('abc'), REDACTED);
    assert.equal(truncate('abcdefgh'), REDACTED);
  });

  it('hides anything that is not a string', () => {
    assert.equal(truncate(undefined), REDACTED);
    assert.equal(truncate(12345678901234), REDACTED);
  });

  it('keeps enough to tell two signatures apart', () => {
    // The reason for a prefix rather than a full hide: comparing two attempts
    // in a log is the common debugging move.
    assert.notEqual(truncate('a'.repeat(64)), truncate('b'.repeat(64)));
  });
});

describe('redactHeaders', () => {
  it('truncates signatures', () => {
    const out = redactHeaders({ 'x-signature': SIGNATURE });

    assert.equal(out['x-signature'], 'aaaaaaaa…(64)');
    assert.ok(!out['x-signature'].includes(SIGNATURE));
  });

  it('hides credentials entirely', () => {
    for (const name of HIDDEN_HEADERS) {
      assert.equal(redactHeaders({ [name]: 'Bearer sk_live_xyz' })[name], REDACTED);
    }
  });

  it('keeps the fields that make a log worth reading', () => {
    // A public key id, a per-request nonce and an idempotency key are not
    // credentials, and hiding them makes a log useless for tracing.
    const out = redactHeaders({
      'x-api-key': KEY_ID,
      'x-nonce': 'ff00ff00',
      'idempotency-key': 'job-42',
      'content-type': 'application/json',
    });

    assert.equal(out['x-api-key'], KEY_ID);
    assert.equal(out['x-nonce'], 'ff00ff00');
    assert.equal(out['idempotency-key'], 'job-42');
    assert.equal(out['content-type'], 'application/json');
  });

  it('is case-insensitive about header names', () => {
    assert.equal(redactHeaders({ 'X-Signature': SIGNATURE })['x-signature'], 'aaaaaaaa…(64)');
    assert.equal(redactHeaders({ Authorization: 'x' }).authorization, REDACTED);
  });

  it('does not mutate the headers it was given', () => {
    // A redactor that edited the outgoing headers would break the signature.
    const headers = { 'x-signature': SIGNATURE };
    redactHeaders(headers);

    assert.equal(headers['x-signature'], SIGNATURE);
  });

  it('survives absent or malformed input', () => {
    assert.deepEqual(redactHeaders(undefined), {});
    assert.deepEqual(redactHeaders(null), {});
    assert.deepEqual(redactHeaders('nope'), {});
  });

  it('covers both signature header names', () => {
    assert.deepEqual([...TRUNCATED_HEADERS], ['x-signature', 'x-webhook-signature']);
  });
});

describe('redactUrl', () => {
  it('hides a credential smuggled into the query', () => {
    const out = redactUrl('https://api.example.com/t?token=sk_live_xyz&limit=10');

    assert.ok(!out.includes('sk_live_xyz'));
    assert.ok(out.includes('limit=10'));
  });

  it('covers the names APIs actually use', () => {
    for (const name of ['token', 'access_token', 'api_key', 'apikey', 'secret', 'signature']) {
      const out = redactUrl(`https://api.example.com/t?${name}=leaked`);
      assert.ok(!out.includes('leaked'), name);
    }
  });

  it('is case-insensitive about parameter names', () => {
    assert.ok(!redactUrl('https://api.example.com/t?TOKEN=leaked').includes('leaked'));
  });

  it('leaves an ordinary URL untouched, character for character', () => {
    const url = 'https://api.example.com/terminals?limit=10&status=active';

    assert.equal(redactUrl(url), url);
  });

  it('returns a malformed URL unchanged rather than throwing', () => {
    assert.equal(redactUrl('not a url'), 'not a url');
  });
});

describe('event builders', () => {
  it('omits the request body entirely', () => {
    // The body is the largest thing in the request and the most likely to
    // hold card numbers and addresses. Logging it by default would trade one
    // leak for a worse one.
    const event = requestEvent({
      method: 'post',
      url: 'https://api.example.com/capture',
      headers: { 'x-signature': SIGNATURE },
      attempt: 1,
    });

    assert.ok(!('body' in event));
    assert.equal(event.method, 'POST');
    assert.equal(event.headers['x-signature'], 'aaaaaaaa…(64)');
  });

  it('surfaces the request id from a response', () => {
    const event = responseEvent({
      method: 'GET',
      url: 'https://api.example.com/t',
      status: 500,
      headers: { 'x-request-id': 'req_abc' },
      durationMs: 12,
      attempt: 2,
    });

    assert.equal(event.requestId, 'req_abc');
    assert.equal(event.attempt, 2);
  });
});

describe('TerminalClient — the hooks', () => {
  it('reports every request and response', async () => {
    const requests = [];
    const responses = [];
    const fetchImpl = sequenceFetch([{}]);

    await makeClient(fetchImpl, {
      onRequest: (e) => requests.push(e),
      onResponse: (e) => responses.push(e),
    }).get('/terminals', { query: { limit: 10 } });

    assert.equal(requests.length, 1);
    assert.equal(responses.length, 1);
    assert.equal(requests[0].url, 'https://api.example.com/terminals?limit=10');
    assert.equal(responses[0].status, 200);
    assert.ok(responses[0].durationMs >= 0);
  });

  it('never hands the hook a usable signature', async () => {
    const requests = [];
    const fetchImpl = sequenceFetch([{}]);

    await makeClient(fetchImpl, { onRequest: (e) => requests.push(e) }).get('/terminals');

    const sent = fetchImpl.calls[0].init.headers['x-signature'];
    const logged = requests[0].headers['x-signature'];

    assert.match(sent, /^[0-9a-f]{64}$/);
    assert.notEqual(logged, sent);
    assert.ok(logged.length < sent.length);
  });

  it('never hands the hook the secret, anywhere', async () => {
    const events = [];
    const fetchImpl = sequenceFetch([{}]);

    await makeClient(fetchImpl, {
      onRequest: (e) => events.push(e),
      onResponse: (e) => events.push(e),
    }).post('/terminals', { amount: 1250 });

    assert.ok(!JSON.stringify(events).includes(SECRET));
  });

  it('numbers the attempts so retries are distinguishable', async () => {
    const requests = [];
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl, { onRequest: (e) => requests.push(e) }).get('/terminals');

    assert.deepEqual(requests.map((e) => e.attempt), [1, 2, 3]);
  });

  it('keeps the idempotency key visible across a retried write', async () => {
    // The single most useful field when tracing a write that was retried:
    // it says whether the second attempt could safely be a duplicate.
    const requests = [];
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl, {
      idempotency: true,
      onRequest: (e) => requests.push(e),
    }).post('/terminals/T-1/capture', { amount: 1250 });

    const keys = requests.map((e) => e.idempotencyKey);
    assert.equal(new Set(keys).size, 1);
    assert.match(keys[0], /^[0-9a-f-]{36}$/);
  });

  it('reports the response even when the status is an error', async () => {
    const responses = [];
    const fetchImpl = sequenceFetch([{ status: 404 }]);

    await assert.rejects(
      makeClient(fetchImpl, { retry: false, onResponse: (e) => responses.push(e) }).get('/nope'),
    );

    assert.equal(responses[0].status, 404);
  });

  it('does not report a response that never arrived', async () => {
    const requests = [];
    const responses = [];
    const fetchImpl = sequenceFetch([new TypeError('fetch failed')]);

    await assert.rejects(
      makeClient(fetchImpl, {
        retry: false,
        onRequest: (e) => requests.push(e),
        onResponse: (e) => responses.push(e),
      }).get('/terminals'),
    );

    assert.equal(requests.length, 1);
    assert.equal(responses.length, 0);
  });

  it('works with no hooks at all', async () => {
    const fetchImpl = sequenceFetch([{}]);

    await assert.doesNotReject(makeClient(fetchImpl).get('/terminals'));
  });
});
