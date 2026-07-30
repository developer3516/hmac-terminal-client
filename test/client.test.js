import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApiError,
  AuthError,
  ConfigError,
  HEADER,
  NetworkError,
  RateLimitError,
  TerminalClient,
  TimeoutError,
  parseRetryAfter,
  verifyRequest,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';

/**
 * A fetch stub that records the call and replays a canned response.
 */
function stubFetch({ status = 200, body = { ok: true }, headers = {}, throws } = {}) {
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw throws;

    const isJson = typeof body !== 'string';
    // 204/205/304 are null-body statuses — the Response constructor rejects a
    // body for them, even an empty string.
    const nullBody = status === 204 || status === 205 || status === 304;

    return new Response(nullBody ? null : isJson ? JSON.stringify(body) : body, {
      status,
      headers: { 'content-type': isJson ? 'application/json' : 'text/plain', ...headers },
    });
  };

  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeClient(fetchImpl, overrides = {}) {
  return new TerminalClient({
    baseUrl: 'https://api.example.com',
    keyId: KEY_ID,
    secret: SECRET,
    fetch: fetchImpl,
    ...overrides,
  });
}

describe('TerminalClient — construction', () => {
  it('requires baseUrl, keyId and secret', () => {
    assert.throws(() => new TerminalClient({}), ConfigError);
    assert.throws(() => new TerminalClient({ baseUrl: 'https://a.co' }), /keyId is required/);
    assert.throws(() => new TerminalClient({ baseUrl: 'https://a.co', keyId: 'k' }), /secret is required/);
  });

  it('rejects a malformed baseUrl', () => {
    assert.throws(() => new TerminalClient({ baseUrl: 'not a url', keyId: 'k', secret: 's' }), /not a valid URL/);
  });

  it('refuses plaintext http for a remote host', () => {
    assert.throws(
      () => new TerminalClient({ baseUrl: 'http://api.example.com', keyId: 'k', secret: 's' }),
      /must use https/,
    );
  });

  it('allows http on localhost for development', () => {
    assert.doesNotThrow(() => new TerminalClient({ baseUrl: 'http://localhost:3000', keyId: 'k', secret: 's' }));
    assert.doesNotThrow(() => new TerminalClient({ baseUrl: 'http://127.0.0.1:3000', keyId: 'k', secret: 's' }));
  });
});

describe('TerminalClient — request construction', () => {
  it('signs the request with headers a server can verify', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).post('/terminals/T-1/capture', { amount: 1250 }, { query: { dryRun: true } });

    const { init } = fetchImpl.calls[0];
    const result = verifyRequest({
      secret: SECRET,
      headers: init.headers,
      method: 'POST',
      path: '/terminals/T-1/capture',
      query: { dryRun: true },
      body: { amount: 1250 },
    });

    assert.equal(result.valid, true, result.reason ?? '');
  });

  it('sends the same canonical query string that it signed', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).get('/terminals', { query: { status: 'active', limit: 10 } });

    // Sorted, not insertion-ordered — proving the wire form is the signed form.
    assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/terminals?limit=10&status=active');
  });

  it('omits the question mark when there is no query', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).get('/terminals');

    assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/terminals');
  });

  it('includes a baseUrl path prefix in both the URL and the signature', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl, { baseUrl: 'https://api.example.com/v2/' }).get('/terminals');

    assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/v2/terminals');

    const result = verifyRequest({
      secret: SECRET,
      headers: fetchImpl.calls[0].init.headers,
      method: 'GET',
      path: '/v2/terminals',
    });
    assert.equal(result.valid, true, result.reason ?? '');
  });

  it('accepts a path without a leading slash', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).get('terminals');

    assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/terminals');
  });

  it('JSON-encodes an object body and sets content-type', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).post('/notes', { text: 'hi' });

    const { init } = fetchImpl.calls[0];
    assert.equal(init.body, '{"text":"hi"}');
    assert.equal(init.headers['content-type'], 'application/json');
  });

  it('leaves a string body untouched and does not force a content-type', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).post('/raw', 'plain text', { headers: { 'Content-Type': 'text/plain' } });

    const { init } = fetchImpl.calls[0];
    assert.equal(init.body, 'plain text');
    assert.equal(init.headers['content-type'], 'text/plain');
  });

  it('sends no body at all for GET', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).get('/terminals');

    assert.equal(fetchImpl.calls[0].init.body, undefined);
  });

  it('merges default and per-call headers without letting them overwrite the signature', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl, { defaultHeaders: { 'x-tenant': 'acme' } }).get('/terminals', {
      headers: { 'X-Signature': 'forged', 'x-trace': 't-1' },
    });

    const { headers } = fetchImpl.calls[0].init;
    assert.equal(headers['x-tenant'], 'acme');
    assert.equal(headers['x-trace'], 't-1');
    assert.notEqual(headers[HEADER.signature], 'forged');
  });

  it('uses a fresh nonce for every request', async () => {
    const fetchImpl = stubFetch();
    const client = makeClient(fetchImpl);

    await client.get('/terminals');
    await client.get('/terminals');

    const [a, b] = fetchImpl.calls.map((call) => call.init.headers[HEADER.nonce]);
    assert.notEqual(a, b);
  });

  it('uppercases the HTTP method on the wire', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).request('patch', '/terminals/T-1', { body: { label: 'front desk' } });

    assert.equal(fetchImpl.calls[0].init.method, 'PATCH');
  });
});

describe('TerminalClient — responses', () => {
  it('unwraps the parsed body from the verb helpers', async () => {
    const client = makeClient(stubFetch({ body: { id: 'T-1' } }));
    assert.deepEqual(await client.get('/terminals/T-1'), { id: 'T-1' });
  });

  it('exposes status and headers from request()', async () => {
    const client = makeClient(stubFetch({ status: 201, headers: { 'x-request-id': 'req_1' } }));
    const response = await client.request('POST', '/terminals', { body: {} });

    assert.equal(response.status, 201);
    assert.equal(response.headers['x-request-id'], 'req_1');
  });

  it('returns null for an empty body', async () => {
    const client = makeClient(stubFetch({ status: 204, body: '' }));
    assert.equal(await client.delete('/terminals/T-1'), null);
  });

  it('returns raw text when the response is not JSON', async () => {
    const client = makeClient(stubFetch({ body: 'pong' }));
    assert.equal(await client.get('/ping'), 'pong');
  });

  it('returns the raw text when a JSON content-type carries invalid JSON', async () => {
    const client = makeClient(stubFetch({ body: 'not json', headers: { 'content-type': 'application/json' } }));
    assert.equal(await client.get('/ping'), 'not json');
  });
});

describe('TerminalClient — errors', () => {
  it('maps 401 and 403 to AuthError', async () => {
    for (const status of [401, 403]) {
      const client = makeClient(stubFetch({ status, body: { message: 'bad signature' } }));
      await assert.rejects(client.get('/terminals'), (error) => {
        assert.ok(error instanceof AuthError);
        assert.equal(error.status, status);
        assert.equal(error.message, 'bad signature');
        return true;
      });
    }
  });

  it('maps 429 to RateLimitError and parses Retry-After', async () => {
    const client = makeClient(stubFetch({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '30' } }));

    await assert.rejects(client.get('/terminals'), (error) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    });
  });

  it('maps other non-2xx statuses to ApiError and keeps the body', async () => {
    const client = makeClient(stubFetch({ status: 500, body: { code: 'internal', message: 'boom' } }));

    await assert.rejects(client.get('/terminals'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'internal');
      assert.deepEqual(error.body, { code: 'internal', message: 'boom' });
      return true;
    });
  });

  it('falls back to a status message when the error body has none', async () => {
    const client = makeClient(stubFetch({ status: 502, body: {} }));
    await assert.rejects(client.get('/terminals'), /Request failed with status 502/);
  });

  it('captures x-request-id for support escalation', async () => {
    const client = makeClient(stubFetch({ status: 400, body: {}, headers: { 'x-request-id': 'req_abc' } }));

    await assert.rejects(client.get('/terminals'), (error) => {
      assert.equal(error.requestId, 'req_abc');
      return true;
    });
  });

  it('wraps a transport failure in NetworkError with the original as cause', async () => {
    const cause = new TypeError('fetch failed');
    const client = makeClient(stubFetch({ throws: cause }));

    await assert.rejects(client.get('/terminals'), (error) => {
      assert.ok(error instanceof NetworkError);
      assert.equal(error.cause, cause);
      return true;
    });
  });

  it('raises TimeoutError when the request outlives the timeout', async () => {
    const fetchImpl = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });

    const client = makeClient(fetchImpl, { timeoutMs: 20 });

    await assert.rejects(client.get('/slow'), (error) => {
      assert.ok(error instanceof TimeoutError);
      assert.equal(error.timeoutMs, 20);
      return true;
    });
  });

  it('propagates a caller abort as-is rather than reporting a timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });

    const client = makeClient(fetchImpl);
    const pending = client.get('/slow', { signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error) => {
      assert.ok(!(error instanceof TimeoutError));
      return true;
    });
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    assert.equal(parseRetryAfter('30'), 30_000);
    assert.equal(parseRetryAfter('0'), 0);
  });

  it('parses an HTTP-date', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfter(future);
    assert.ok(parsed > 55_000 && parsed <= 60_000, `got ${parsed}`);
  });

  it('never returns a negative delay for a past date', () => {
    assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
  });

  it('returns null when absent or unparseable', () => {
    assert.equal(parseRetryAfter(undefined), null);
    assert.equal(parseRetryAfter('soon'), null);
  });
});
