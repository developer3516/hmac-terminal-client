import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApiError,
  CIRCUIT_STATE,
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_BREAKER,
  NetworkError,
  TerminalClient,
  TimeoutError,
  TokenBucket,
  countsAsFailure,
  resolveBreaker,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';

/** A clock the test drives by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** Serves whatever status the caller sets, and counts calls. */
function switchableFetch(initialStatus = 500) {
  const state = { status: initialStatus, calls: 0 };

  const fetchImpl = async () => {
    state.calls += 1;
    if (state.status === 'network') throw new TypeError('fetch failed');

    return new Response(JSON.stringify({ ok: true }), {
      status: state.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  fetchImpl.state = state;
  return fetchImpl;
}

const makeClient = (fetchImpl, overrides = {}) =>
  new TerminalClient({
    baseUrl: 'https://api.example.com',
    keyId: KEY_ID,
    secret: SECRET,
    fetch: fetchImpl,
    retry: false,
    ...overrides,
  });

describe('countsAsFailure', () => {
  it('counts what says the service is unreachable or broken', () => {
    assert.equal(countsAsFailure(new NetworkError('socket hang up')), true);
    assert.equal(countsAsFailure(new TimeoutError(1000)), true);
    assert.equal(countsAsFailure(new ApiError('boom', { status: 500 })), true);
    assert.equal(countsAsFailure(new ApiError('unavailable', { status: 503 })), true);
  });

  it('does not count a working service answering correctly', () => {
    // A caller looping over missing records would otherwise trip the breaker
    // for everybody else.
    assert.equal(countsAsFailure(new ApiError('not found', { status: 404 })), false);
    assert.equal(countsAsFailure(new ApiError('bad request', { status: 400 })), false);
    assert.equal(countsAsFailure(new ApiError('nope', { status: 401 })), false);
  });
});

describe('CircuitBreaker', () => {
  const trip = (breaker, n) => {
    for (let i = 0; i < n; i += 1) breaker.recordFailure(new NetworkError('down'));
  };

  it('starts closed', () => {
    const breaker = new CircuitBreaker({ now: fakeClock() });

    assert.equal(breaker.state, CIRCUIT_STATE.closed);
    assert.equal(breaker.failures, 0);
    assert.doesNotThrow(() => breaker.assertAvailable());
  });

  it('opens on the threshold, not before', () => {
    const breaker = new CircuitBreaker({ threshold: 3, now: fakeClock() });

    trip(breaker, 2);
    assert.equal(breaker.state, CIRCUIT_STATE.closed);

    trip(breaker, 1);
    assert.equal(breaker.state, CIRCUIT_STATE.open);
  });

  it('refuses requests while open, with a useful error', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 5000, now: fakeClock() });
    trip(breaker, 1);

    assert.throws(() => breaker.assertAvailable(), (error) => {
      assert.ok(error instanceof CircuitOpenError);
      assert.equal(error.failures, 1);
      assert.equal(error.retryAfterMs, 5000);
      assert.ok(error.lastError instanceof NetworkError);
      return true;
    });
  });

  it('counts down to the next probe', () => {
    const now = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, now });
    trip(breaker, 1);

    assert.equal(breaker.retryAfterMs, 1000);
    now.advance(400);
    assert.equal(breaker.retryAfterMs, 600);
  });

  it('goes half-open once the cooldown elapses', () => {
    const now = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, now });
    trip(breaker, 1);

    now.advance(999);
    assert.equal(breaker.state, CIRCUIT_STATE.open);

    now.advance(1);
    assert.equal(breaker.state, CIRCUIT_STATE.halfOpen);
    assert.equal(breaker.retryAfterMs, 0);
  });

  it('admits exactly one probe, not the whole queue', () => {
    // Letting everything waiting through is precisely the thundering herd the
    // breaker exists to prevent.
    const now = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 100, now });
    trip(breaker, 1);
    now.advance(100);

    assert.doesNotThrow(() => breaker.assertAvailable());
    assert.throws(() => breaker.assertAvailable(), /probe is already in flight/);
    assert.throws(() => breaker.assertAvailable(), CircuitOpenError);
  });

  it('closes when the probe succeeds', () => {
    const now = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 100, now });
    trip(breaker, 2);
    now.advance(100);

    breaker.assertAvailable();
    breaker.recordSuccess();

    assert.equal(breaker.state, CIRCUIT_STATE.closed);
    assert.equal(breaker.failures, 0);
  });

  it('reopens for a full cooldown when the probe fails', () => {
    // The probe just demonstrated the service is still down; the next caller
    // should not walk straight back in.
    const now = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 100, now });
    trip(breaker, 2);
    now.advance(100);

    breaker.assertAvailable();
    breaker.recordFailure(new NetworkError('still down'));

    assert.equal(breaker.state, CIRCUIT_STATE.open);
    assert.equal(breaker.retryAfterMs, 100);
  });

  it('opens on a single failed probe regardless of the threshold', () => {
    const now = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 10, cooldownMs: 100, now });
    trip(breaker, 10);
    now.advance(100);

    breaker.assertAvailable();
    breaker.recordFailure(new NetworkError('still down'));

    assert.equal(breaker.state, CIRCUIT_STATE.open);
  });

  it('resets the count on any success', () => {
    const breaker = new CircuitBreaker({ threshold: 3, now: fakeClock() });

    trip(breaker, 2);
    breaker.recordSuccess();
    trip(breaker, 2);

    assert.equal(breaker.state, CIRCUIT_STATE.closed);
    assert.equal(breaker.failures, 2);
  });

  it('ignores failures that do not implicate the service', () => {
    const breaker = new CircuitBreaker({ threshold: 2, now: fakeClock() });

    breaker.recordFailure(new ApiError('not found', { status: 404 }));
    breaker.recordFailure(new ApiError('not found', { status: 404 }));
    breaker.recordFailure(new ApiError('nope', { status: 401 }));

    assert.equal(breaker.state, CIRCUIT_STATE.closed);
    assert.equal(breaker.failures, 0);
  });

  it('does not let a 404 reset an accumulating outage', () => {
    // Neither counting nor resetting: an intermittent outage interleaved with
    // 404s would otherwise never trip.
    const breaker = new CircuitBreaker({ threshold: 2, now: fakeClock() });

    breaker.recordFailure(new NetworkError('down'));
    breaker.recordFailure(new ApiError('not found', { status: 404 }));
    breaker.recordFailure(new NetworkError('down'));

    assert.equal(breaker.state, CIRCUIT_STATE.open);
  });

  it('rejects nonsensical settings', () => {
    assert.throws(() => new CircuitBreaker({ threshold: 0 }), RangeError);
    assert.throws(() => new CircuitBreaker({ threshold: 1.5 }), RangeError);
    assert.throws(() => new CircuitBreaker({ cooldownMs: -1 }), RangeError);
    assert.throws(() => new CircuitBreaker({ cooldownMs: Infinity }), RangeError);
  });

  it('can be forced closed', () => {
    const breaker = new CircuitBreaker({ threshold: 1, now: fakeClock() });
    trip(breaker, 1);

    breaker.reset();

    assert.equal(breaker.state, CIRCUIT_STATE.closed);
  });
});

describe('resolveBreaker', () => {
  it('is off unless asked for', () => {
    assert.equal(resolveBreaker(undefined), null);
    assert.equal(resolveBreaker(false), null);
  });

  it('takes the defaults for true', () => {
    assert.equal(resolveBreaker(true).state, CIRCUIT_STATE.closed);
    assert.equal(DEFAULT_BREAKER.threshold, 5);
  });

  it('passes an existing breaker through, so clients can share one', () => {
    const breaker = new CircuitBreaker();

    assert.equal(resolveBreaker(breaker), breaker);
  });
});

describe('TerminalClient — the breaker', () => {
  it('opens after the threshold and then fails without a socket', async () => {
    const fetchImpl = switchableFetch(503);
    const client = makeClient(fetchImpl, { circuitBreaker: { threshold: 3, cooldownMs: 60_000 } });

    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(client.get('/terminals'));
    }
    assert.equal(fetchImpl.state.calls, 3);

    await assert.rejects(client.get('/terminals'), CircuitOpenError);
    await assert.rejects(client.get('/terminals'), CircuitOpenError);

    // Still three. The refused calls never reached fetch.
    assert.equal(fetchImpl.state.calls, 3);
  });

  it('does not trip on 404s', async () => {
    const fetchImpl = switchableFetch(404);
    const client = makeClient(fetchImpl, { circuitBreaker: { threshold: 2 } });

    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(client.get('/missing'));
    }

    assert.equal(fetchImpl.state.calls, 5, 'every request should have gone out');
  });

  it('counts a network failure', async () => {
    const fetchImpl = switchableFetch('network');
    const client = makeClient(fetchImpl, { circuitBreaker: { threshold: 2, cooldownMs: 60_000 } });

    await assert.rejects(client.get('/a'), NetworkError);
    await assert.rejects(client.get('/b'), NetworkError);
    await assert.rejects(client.get('/c'), CircuitOpenError);

    assert.equal(fetchImpl.state.calls, 2);
  });

  it('recovers after the cooldown when the service comes back', async () => {
    const fetchImpl = switchableFetch(503);
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 5 });
    const client = makeClient(fetchImpl, { circuitBreaker: breaker });

    await assert.rejects(client.get('/a'));
    await assert.rejects(client.get('/b'));
    await assert.rejects(client.get('/c'), CircuitOpenError);

    fetchImpl.state.status = 200;
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.doesNotReject(client.get('/d'));
    assert.equal(breaker.state, CIRCUIT_STATE.closed);
  });

  it('reports how long until the next probe', async () => {
    const fetchImpl = switchableFetch(503);
    const client = makeClient(fetchImpl, { circuitBreaker: { threshold: 1, cooldownMs: 30_000 } });

    await assert.rejects(client.get('/a'));

    await assert.rejects(client.get('/b'), (error) => {
      assert.ok(error instanceof CircuitOpenError);
      assert.ok(error.retryAfterMs > 25_000);
      return true;
    });
  });

  it('does not spend a rate-limit token on a refused request', async () => {
    // During an outage that quota is exactly what recovery will need.
    const fetchImpl = switchableFetch(503);
    const bucket = new TokenBucket({ requestsPerSecond: 0.01, burst: 5 });
    const client = makeClient(fetchImpl, {
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
      rateLimit: bucket,
    });

    await assert.rejects(client.get('/a'));
    const remaining = bucket.tokens;

    await assert.rejects(client.get('/b'), CircuitOpenError);
    await assert.rejects(client.get('/c'), CircuitOpenError);

    // Not exact equality: the bucket refills continuously, so a few
    // microseconds between the two reads move it by a fraction. Taking a
    // token subtracts a whole one, so 'did not go down' is the assertion
    // that actually distinguishes the two cases.
    assert.ok(
      bucket.tokens >= remaining,
      `tokens fell from ${remaining} to ${bucket.tokens} — a refused request spent one`,
    );
  });

  it('does not retry an open circuit', async () => {
    // Retrying a request that is not going out is pure delay.
    const fetchImpl = switchableFetch(503);
    const client = makeClient(fetchImpl, {
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
      retry: { retries: 3, minDelayMs: 1, maxDelayMs: 1 },
      random: () => 0,
    });

    await assert.rejects(client.get('/a'));
    const afterFirst = fetchImpl.state.calls;

    await assert.rejects(client.get('/b'), CircuitOpenError);

    assert.equal(fetchImpl.state.calls, afterFirst);
  });

  it('lets retries feed the breaker while it is closed', async () => {
    const fetchImpl = switchableFetch(503);
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
    const client = makeClient(fetchImpl, {
      circuitBreaker: breaker,
      retry: { retries: 2, minDelayMs: 1, maxDelayMs: 1 },
      random: () => 0,
    });

    // One logical request, three attempts, three failures — enough to trip.
    await assert.rejects(client.get('/a'));

    assert.equal(fetchImpl.state.calls, 3);
    assert.equal(breaker.state, CIRCUIT_STATE.open);
  });

  it('shares one breaker across clients', async () => {
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    const a = makeClient(switchableFetch(503), { circuitBreaker: breaker });
    const b = makeClient(switchableFetch(503), { circuitBreaker: breaker });

    await assert.rejects(a.get('/one'));
    await assert.rejects(b.get('/two'));

    await assert.rejects(a.get('/three'), CircuitOpenError);
    await assert.rejects(b.get('/four'), CircuitOpenError);
  });

  it('does nothing at all when disabled', async () => {
    const fetchImpl = switchableFetch(503);
    const client = makeClient(fetchImpl);

    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(client.get('/a'));
    }

    assert.equal(fetchImpl.state.calls, 10);
  });
});
