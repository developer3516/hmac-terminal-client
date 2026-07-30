import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApiError,
  AuthError,
  ConfigError,
  DEFAULT_RETRY_POLICY,
  HEADER,
  NetworkError,
  RateLimitError,
  SignatureError,
  TerminalClient,
  TimeoutError,
  computeDelay,
  isRetryableError,
  resolvePolicy,
  sleep,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';

/**
 * A fetch stub that replays a scripted sequence, one entry per call.
 * Each entry is either a status/body pair or an Error to throw.
 */
function sequenceFetch(steps) {
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];

    if (step instanceof Error) throw step;

    const { status = 200, body = { ok: true }, headers = {} } = step;
    const nullBody = status === 204 || status === 205 || status === 304;

    return new Response(nullBody ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };

  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Delays collapse to zero so the suite stays fast but the logic is unchanged. */
function makeClient(fetchImpl, overrides = {}) {
  return new TerminalClient({
    baseUrl: 'https://api.example.com',
    keyId: KEY_ID,
    secret: SECRET,
    fetch: fetchImpl,
    random: () => 0,
    retry: { minDelayMs: 1, maxDelayMs: 5 },
    ...overrides,
  });
}

describe('isRetryableError', () => {
  it('retries transport failures', () => {
    assert.equal(isRetryableError(new NetworkError('socket hang up')), true);
    assert.equal(isRetryableError(new TimeoutError(1000)), true);
  });

  it('retries 429, 408 and 5xx', () => {
    assert.equal(isRetryableError(new RateLimitError('slow down', { status: 429 })), true);
    assert.equal(isRetryableError(new ApiError('timeout', { status: 408 })), true);
    assert.equal(isRetryableError(new ApiError('boom', { status: 500 })), true);
    assert.equal(isRetryableError(new ApiError('unavailable', { status: 503 })), true);
  });

  it('does not retry auth failures — a bad signature stays bad', () => {
    assert.equal(isRetryableError(new AuthError('nope', { status: 401 })), false);
    assert.equal(isRetryableError(new AuthError('nope', { status: 403 })), false);
  });

  it('does not retry other 4xx', () => {
    assert.equal(isRetryableError(new ApiError('bad request', { status: 400 })), false);
    assert.equal(isRetryableError(new ApiError('not found', { status: 404 })), false);
    assert.equal(isRetryableError(new ApiError('conflict', { status: 409 })), false);
  });

  it('does not retry caller bugs', () => {
    assert.equal(isRetryableError(new ConfigError('missing baseUrl')), false);
    assert.equal(isRetryableError(new SignatureError('empty secret')), false);
    assert.equal(isRetryableError(new Error('something else')), false);
  });
});

describe('resolvePolicy', () => {
  const base = DEFAULT_RETRY_POLICY;

  it('allows retries on idempotent methods', () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      assert.equal(resolvePolicy(base, undefined, method).retries, base.retries, method);
    }
  });

  it('refuses to replay POST and PATCH by default', () => {
    // The response may have been lost after the server already applied the
    // write — replaying it is how a capture gets charged twice.
    assert.equal(resolvePolicy(base, undefined, 'POST').retries, 0);
    assert.equal(resolvePolicy(base, undefined, 'PATCH').retries, 0);
  });

  it('lets an explicit retry:true opt a POST in', () => {
    assert.equal(resolvePolicy(base, true, 'POST').retries, base.retries);
  });

  it('disables retries entirely on retry:false', () => {
    assert.equal(resolvePolicy(base, false, 'GET').retries, 0);
  });

  it('merges an object override but keeps the allowlist', () => {
    assert.equal(resolvePolicy(base, { retries: 5 }, 'GET').retries, 5);
    assert.equal(resolvePolicy(base, { retries: 5 }, 'POST').retries, 0);
  });

  it('is case-insensitive about the method', () => {
    assert.equal(resolvePolicy(base, undefined, 'get').retries, base.retries);
  });
});

describe('computeDelay', () => {
  const policy = { minDelayMs: 100, maxDelayMs: 10_000, factor: 2 };

  it('grows the ceiling exponentially', () => {
    const atMax = (attempt) => computeDelay(attempt, policy, null, () => 1);

    assert.equal(atMax(0), 100);
    assert.equal(atMax(1), 200);
    assert.equal(atMax(2), 400);
    assert.equal(atMax(3), 800);
  });

  it('caps the ceiling at maxDelayMs', () => {
    assert.equal(computeDelay(20, policy, null, () => 1), 10_000);
  });

  it('applies full jitter — anywhere in [0, ceiling]', () => {
    assert.equal(computeDelay(2, policy, null, () => 0), 0);
    assert.equal(computeDelay(2, policy, null, () => 0.5), 200);
    assert.equal(computeDelay(2, policy, null, () => 1), 400);
  });

  it('never exceeds the ceiling across a sample of real jitter', () => {
    for (let i = 0; i < 200; i += 1) {
      const delay = computeDelay(3, policy);
      assert.ok(delay >= 0 && delay <= 800, `got ${delay}`);
    }
  });

  it('prefers the server Retry-After over the computed backoff', () => {
    // The server knows when capacity returns; we are only guessing.
    assert.equal(computeDelay(0, policy, 3_000, () => 1), 3_000);
  });

  it('still caps Retry-After, so a bad header cannot park the caller', () => {
    assert.equal(computeDelay(0, policy, 3_600_000, () => 1), 10_000);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now();
    await sleep(20);
    assert.ok(Date.now() - started >= 15);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(sleep(10_000, controller.signal));
  });

  it('rejects as soon as the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    setTimeout(() => controller.abort(), 5);

    await assert.rejects(pending);
  });
});

describe('TerminalClient — retry behaviour', () => {
  it('retries a 500 and returns the eventual success', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 200, body: { id: 'T-1' } }]);

    assert.deepEqual(await makeClient(fetchImpl).get('/terminals'), { id: 'T-1' });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('retries a dropped connection', async () => {
    const fetchImpl = sequenceFetch([new TypeError('fetch failed'), { status: 200 }]);

    await makeClient(fetchImpl).get('/terminals');
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('gives up after the configured number of retries', async () => {
    const fetchImpl = sequenceFetch([{ status: 503 }]);

    await assert.rejects(makeClient(fetchImpl).get('/terminals'), (error) => {
      assert.equal(error.status, 503);
      return true;
    });

    // One original attempt plus two retries.
    assert.equal(fetchImpl.calls.length, 3);
  });

  it('does not retry a 401', async () => {
    const fetchImpl = sequenceFetch([{ status: 401 }]);

    await assert.rejects(makeClient(fetchImpl).get('/terminals'), AuthError);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('does not retry a POST by default', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }]);

    await assert.rejects(makeClient(fetchImpl).post('/terminals/T-1/capture', { amount: 1250 }));
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('retries a POST when the caller explicitly opts in', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl).post('/terminals/T-1/capture', { amount: 1250 }, { retry: true });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('honours retry:false on a per-call basis', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }]);

    await assert.rejects(makeClient(fetchImpl).get('/terminals', { retry: false }));
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('honours retry:false on the client', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }]);

    await assert.rejects(makeClient(fetchImpl, { retry: false }).get('/terminals'));
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('signs every attempt afresh', async () => {
    // A replayed signature carries a stale timestamp and a nonce the server
    // may already have seen, so a retried 503 would come back as a 401.
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 500 }, { status: 200 }]);

    await makeClient(fetchImpl).get('/terminals');

    const nonces = fetchImpl.calls.map((call) => call.init.headers[HEADER.nonce]);
    const signatures = fetchImpl.calls.map((call) => call.init.headers[HEADER.signature]);

    assert.equal(new Set(nonces).size, 3);
    assert.equal(new Set(signatures).size, 3);
  });

  it('reports each retry through onRetry', async () => {
    const seen = [];
    const fetchImpl = sequenceFetch([{ status: 500 }, { status: 503 }, { status: 200 }]);

    await makeClient(fetchImpl, { onRetry: (info) => seen.push(info) }).get('/terminals');

    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen.map((info) => [info.attempt, info.error.status, info.method, info.path]),
      [
        [1, 500, 'GET', '/terminals'],
        [2, 503, 'GET', '/terminals'],
      ],
    );
  });

  it('waits the Retry-After a 503 asks for, capped by maxDelayMs', async () => {
    const seen = [];
    const fetchImpl = sequenceFetch([
      { status: 503, headers: { 'retry-after': '3600' } },
      { status: 200 },
    ]);

    await makeClient(fetchImpl, { onRetry: (info) => seen.push(info) }).get('/terminals');

    // An hour, clamped to the 5ms ceiling this client was built with.
    assert.equal(seen[0].delayMs, 5);
  });

  it('stops retrying when the caller aborts during backoff', async () => {
    const controller = new AbortController();
    const fetchImpl = sequenceFetch([{ status: 500 }]);

    const client = makeClient(fetchImpl, { retry: { minDelayMs: 10_000, maxDelayMs: 10_000 }, random: () => 1 });
    const pending = client.get('/terminals', { signal: controller.signal });

    setTimeout(() => controller.abort(), 10);

    await assert.rejects(pending);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('leaves the default policy untouched when a call overrides it', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }]);
    const client = makeClient(fetchImpl);

    await assert.rejects(client.get('/a', { retry: { retries: 0 } }));
    assert.equal(fetchImpl.calls.length, 1);

    await assert.rejects(client.get('/b'));
    assert.equal(fetchImpl.calls.length, 1 + 3);
  });
});

describe('ApiError.retryAfterMs', () => {
  it('is parsed for any status that sends the header, not just 429', async () => {
    const fetchImpl = sequenceFetch([{ status: 503, headers: { 'retry-after': '30' } }]);

    await assert.rejects(makeClient(fetchImpl, { retry: false }).get('/terminals'), (error) => {
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    });
  });

  it('is null when the server sends no hint', async () => {
    const fetchImpl = sequenceFetch([{ status: 500 }]);

    await assert.rejects(makeClient(fetchImpl, { retry: false }).get('/terminals'), (error) => {
      assert.equal(error.retryAfterMs, null);
      return true;
    });
  });
});
