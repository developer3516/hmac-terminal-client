import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_RATE_LIMIT,
  TerminalClient,
  TokenBucket,
  resolveRateLimit,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';

/** A clock the test drives by hand, so nothing depends on wall time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

function stubFetch({ status = 200 } = {}) {
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push({ url, init, at: Date.now() });
    return new Response(JSON.stringify({ ok: true }), {
      status,
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
    retry: false,
    ...overrides,
  });

describe('TokenBucket', () => {
  it('starts full — a fresh client has consumed nothing', () => {
    const bucket = new TokenBucket({ requestsPerSecond: 5, now: fakeClock() });

    assert.equal(bucket.capacity, 5);
    assert.equal(bucket.tokens, 5);
  });

  it('defaults the burst to one second of capacity', () => {
    assert.equal(new TokenBucket({ requestsPerSecond: 12, now: fakeClock() }).capacity, 12);
  });

  it('takes a burst immediately, then runs dry', () => {
    const bucket = new TokenBucket({ requestsPerSecond: 10, burst: 3, now: fakeClock() });

    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), false);
  });

  it('refills continuously, not on a tick', () => {
    // A timer-based refill would make a caller arriving just after a tick wait
    // a whole interval for a token that was already three-quarters earned.
    const now = fakeClock();
    const bucket = new TokenBucket({ requestsPerSecond: 10, burst: 1, now });

    bucket.tryTake();
    assert.equal(bucket.tryTake(), false);

    now.advance(50); // half a token at 10/s
    assert.equal(bucket.tryTake(), false);
    assert.ok(bucket.tokens > 0.4 && bucket.tokens < 0.6, `got ${bucket.tokens}`);

    now.advance(50);
    assert.equal(bucket.tryTake(), true);
  });

  it('never accumulates beyond the burst', () => {
    const now = fakeClock();
    const bucket = new TokenBucket({ requestsPerSecond: 10, burst: 2, now });

    now.advance(60_000); // idle for a minute

    assert.equal(bucket.tokens, 2);
  });

  it('reports how long until the next token', () => {
    const now = fakeClock();
    const bucket = new TokenBucket({ requestsPerSecond: 10, burst: 1, now });

    assert.equal(bucket.delayMs(), 0);
    bucket.tryTake();
    assert.equal(bucket.delayMs(), 100); // 1/10th of a second

    now.advance(40);
    assert.equal(bucket.delayMs(), 60);
  });

  it('rejects a nonsensical rate rather than dividing by it', () => {
    assert.throws(() => new TokenBucket({ requestsPerSecond: 0 }), RangeError);
    assert.throws(() => new TokenBucket({ requestsPerSecond: -1 }), RangeError);
    assert.throws(() => new TokenBucket({ requestsPerSecond: Infinity }), RangeError);
    assert.throws(() => new TokenBucket({ requestsPerSecond: 10, burst: 0 }), RangeError);
    assert.throws(() => new TokenBucket({ requestsPerSecond: 10, burst: 1.5 }), RangeError);
  });

  it('waits for a token with take()', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 200, burst: 1 });

    await bucket.take();
    const started = Date.now();
    await bucket.take();

    assert.ok(Date.now() - started >= 3, 'should have waited for a refill');
  });

  it('does not hand the same token to two waiters', async () => {
    // Several callers can be waiting on one bucket. The one that wakes first
    // takes the token; without re-checking, the losers would proceed on a
    // token that no longer exists.
    const bucket = new TokenBucket({ requestsPerSecond: 100, burst: 1 });
    const order = [];

    await Promise.all([
      bucket.take().then(() => order.push('a')),
      bucket.take().then(() => order.push('b')),
      bucket.take().then(() => order.push('c')),
    ]);

    assert.equal(order.length, 3);
    assert.equal(bucket.tryTake(), false, 'the bucket should be empty afterwards');
  });

  it('gives up waiting when the signal aborts', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 0.01, burst: 1 });
    const controller = new AbortController();

    await bucket.take();
    const pending = bucket.take(controller.signal);
    setTimeout(() => controller.abort(), 5);

    await assert.rejects(pending);
  });
});

describe('resolveRateLimit', () => {
  it('is off unless asked for', () => {
    assert.equal(resolveRateLimit(undefined), null);
    assert.equal(resolveRateLimit(false), null);
  });

  it('accepts a bare number as a rate', () => {
    assert.equal(resolveRateLimit(25).capacity, 25);
  });

  it('accepts a config object', () => {
    assert.equal(resolveRateLimit({ requestsPerSecond: 4, burst: 9 }).capacity, 9);
  });

  it('passes an existing bucket through, so clients can share one', () => {
    // Several clients against the same API share one quota; sharing the
    // bucket is the only way the total actually stays under it.
    const bucket = new TokenBucket({ requestsPerSecond: 5 });

    assert.equal(resolveRateLimit(bucket), bucket);
  });

  it('has a conservative default rate', () => {
    assert.equal(DEFAULT_RATE_LIMIT.requestsPerSecond, 10);
  });
});

describe('TerminalClient — pacing', () => {
  it('sends the burst immediately and paces the rest', async () => {
    const fetchImpl = stubFetch();
    const client = makeClient(fetchImpl, { rateLimit: { requestsPerSecond: 200, burst: 2 } });

    const started = Date.now();
    await Promise.all([client.get('/a'), client.get('/b'), client.get('/c'), client.get('/d')]);
    const elapsed = Date.now() - started;

    assert.equal(fetchImpl.calls.length, 4);
    // Two free, two at 5ms apiece.
    assert.ok(elapsed >= 8, `finished in ${elapsed}ms, expected pacing`);
  });

  it('does not pace at all when disabled', async () => {
    const fetchImpl = stubFetch();
    const client = makeClient(fetchImpl);

    const started = Date.now();
    await Promise.all(Array.from({ length: 20 }, (_, i) => client.get(`/t/${i}`)));

    assert.equal(fetchImpl.calls.length, 20);
    assert.ok(Date.now() - started < 500);
  });

  it('bounds the rate that bulk concurrency does not', async () => {
    // The confusion this exists for: four workers against a fast endpoint
    // issue hundreds of requests a second while the concurrency setting does
    // exactly what it promised.
    const fetchImpl = stubFetch();
    const client = makeClient(fetchImpl, { rateLimit: { requestsPerSecond: 500, burst: 1 } });

    const started = Date.now();
    await client.bulk(
      Array.from({ length: 8 }, (_, i) => ({ path: `/t/${i}` })),
      { concurrency: 4 },
    );
    const elapsed = Date.now() - started;

    assert.equal(fetchImpl.calls.length, 8);
    // Seven refills at 2ms each, despite four workers being free the whole time.
    assert.ok(elapsed >= 10, `finished in ${elapsed}ms with concurrency 4`);
  });

  it('makes retries pay for their own slot', async () => {
    // A retry is another request as far as the server's limiter cares.
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response('{}', {
        status: calls < 3 ? 500 : 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    // Burst covers all three attempts so nothing waits; the refill is slow
    // enough that the bucket is still empty when the assertion runs.
    const bucket = new TokenBucket({ requestsPerSecond: 0.01, burst: 3 });
    const client = makeClient(fetchImpl, {
      rateLimit: bucket,
      retry: { minDelayMs: 1, maxDelayMs: 1 },
      random: () => 0,
    });

    await client.get('/flaky');

    assert.equal(calls, 3);
    assert.equal(bucket.tryTake(), false, 'all three attempts should have taken a token');
  });

  it('shares one bucket across clients', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 0.01, burst: 2 });
    const a = makeClient(stubFetch(), { rateLimit: bucket });
    const b = makeClient(stubFetch(), { rateLimit: bucket });

    await a.get('/one');
    await b.get('/two');

    assert.equal(bucket.tryTake(), false, 'the two clients drew on the same quota');
  });

  it('waits before signing, so a queued request is not already expired', async () => {
    // Sign first and a request stuck behind a slow bucket carries a timestamp
    // minted minutes earlier — at a low enough rate it arrives outside the
    // server's clock tolerance despite being correctly signed.
    const fetchImpl = stubFetch();
    const bucket = new TokenBucket({ requestsPerSecond: 40, burst: 1 });
    const client = makeClient(fetchImpl, { rateLimit: bucket });

    await client.get('/first');
    await client.get('/second');

    const stamps = fetchImpl.calls.map((c) => Number(c.init.headers['x-timestamp']));
    const sentAt = fetchImpl.calls.map((c) => Math.floor(c.at / 1000));

    // Each signature was minted in the same second the request went out.
    for (const [i, stamp] of stamps.entries()) {
      assert.ok(Math.abs(stamp - sentAt[i]) <= 1, `attempt ${i} signed ${sentAt[i] - stamp}s early`);
    }
  });

  it('releases a queued request when the caller aborts', async () => {
    const fetchImpl = stubFetch();
    const bucket = new TokenBucket({ requestsPerSecond: 0.01, burst: 1 });
    const client = makeClient(fetchImpl, { rateLimit: bucket });
    const controller = new AbortController();

    await client.get('/first');
    const pending = client.get('/second', { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    await assert.rejects(pending);
    assert.equal(fetchImpl.calls.length, 1, 'the queued request never went out');
  });
});
