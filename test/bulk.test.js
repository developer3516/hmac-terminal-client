import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BulkError,
  DEFAULT_CONCURRENCY,
  TerminalClient,
  partition,
  pool,
  sleep,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';

const range = (n) => Array.from({ length: n }, (_, i) => i);

/** Tracks how many handler invocations overlap, to prove the bound holds. */
function concurrencyTracker() {
  let active = 0;
  let peak = 0;

  return {
    get peak() {
      return peak;
    },
    async run(fn) {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await fn();
      } finally {
        active -= 1;
      }
    },
  };
}

describe('pool — ordering and results', () => {
  it('returns results in input order, not completion order', async () => {
    // Deliberately inverted delays: the last item finishes first.
    const results = await pool(
      [30, 20, 10, 0],
      async (delay, index) => {
        await sleep(delay);
        return index;
      },
      { concurrency: 4 },
    );

    assert.deepEqual(
      results.map((r) => r.value),
      [0, 1, 2, 3],
    );
  });

  it('passes both the item and its index to the handler', async () => {
    const seen = [];
    await pool(['a', 'b', 'c'], async (item, index) => seen.push([item, index]), { concurrency: 1 });

    assert.deepEqual(seen, [['a', 0], ['b', 1], ['c', 2]]);
  });

  it('handles an empty input', async () => {
    assert.deepEqual(await pool([], async () => 1), []);
  });

  it('accepts any iterable, not just arrays', async () => {
    const results = await pool(new Set([1, 2, 3]), async (n) => n * 2);

    assert.deepEqual(
      results.map((r) => r.value),
      [2, 4, 6],
    );
  });
});

describe('pool — concurrency bound', () => {
  it('never exceeds the configured concurrency', async () => {
    const tracker = concurrencyTracker();

    await pool(range(20), (i) => tracker.run(() => sleep(i % 3)), { concurrency: 3 });

    assert.ok(tracker.peak <= 3, `peak was ${tracker.peak}`);
  });

  it('actually reaches the bound rather than serialising', async () => {
    const tracker = concurrencyTracker();

    await pool(range(20), () => tracker.run(() => sleep(5)), { concurrency: 4 });

    assert.equal(tracker.peak, 4);
  });

  it('does not spawn more workers than there are items', async () => {
    const tracker = concurrencyTracker();

    await pool(range(2), () => tracker.run(() => sleep(5)), { concurrency: 10 });

    assert.equal(tracker.peak, 2);
  });

  it('defaults to a conservative concurrency', async () => {
    const tracker = concurrencyTracker();

    await pool(range(20), () => tracker.run(() => sleep(5)));

    assert.equal(tracker.peak, DEFAULT_CONCURRENCY);
  });

  it('rejects a nonsensical concurrency instead of silently coping', async () => {
    await assert.rejects(pool([1], async () => 1, { concurrency: 0 }), RangeError);
    await assert.rejects(pool([1], async () => 1, { concurrency: -1 }), RangeError);
    await assert.rejects(pool([1], async () => 1, { concurrency: 1.5 }), RangeError);
  });

  it('rejects a non-function handler', async () => {
    await assert.rejects(pool([1], 'not a function'), TypeError);
  });
});

describe('pool — partial failure', () => {
  it('settles everything by default rather than rejecting the batch', async () => {
    const results = await pool([1, 2, 3, 4], async (n) => {
      if (n % 2 === 0) throw new Error(`item ${n} failed`);
      return n;
    });

    assert.deepEqual(
      results.map((r) => r.status),
      ['fulfilled', 'rejected', 'fulfilled', 'rejected'],
    );
    assert.equal(results[0].value, 1);
    assert.equal(results[1].reason.message, 'item 2 failed');
  });

  it('keeps every success even when most of the batch fails', async () => {
    // Promise.all would discard all of these.
    const results = await pool(range(10), async (n) => {
      if (n !== 7) throw new Error('nope');
      return 'the one that worked';
    });

    assert.equal(results[7].value, 'the one that worked');
  });

  it('throws BulkError on the first failure when stopOnError is set', async () => {
    await assert.rejects(
      pool([1, 2, 3], async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }, { concurrency: 1, stopOnError: true }),
      (error) => {
        assert.ok(error instanceof BulkError);
        assert.equal(error.index, 1);
        assert.equal(error.cause.message, 'boom');
        return true;
      },
    );
  });

  it('carries the partial results on the thrown BulkError', async () => {
    // Without this the caller knows something failed but not what already
    // went through — and so cannot safely retry any of it.
    await assert.rejects(
      pool([1, 2, 3], async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }, { concurrency: 1, stopOnError: true }),
      (error) => {
        assert.equal(error.results[0].status, 'fulfilled');
        assert.equal(error.results[0].value, 1);
        assert.equal(error.results[1].status, 'rejected');
        assert.equal(error.results[2].status, 'skipped');
        return true;
      },
    );
  });

  it('reports the earliest failure by input position, not by which worker lost the race', async () => {
    await assert.rejects(
      pool([0, 1, 2, 3], async (n) => {
        // Item 3 fails fast, item 1 fails slowly — index 1 is the answer.
        if (n === 3) throw new Error('fast failure');
        if (n === 1) {
          await sleep(20);
          throw new Error('slow failure');
        }
        await sleep(40);
        return n;
      }, { concurrency: 4, stopOnError: true }),
      (error) => {
        assert.equal(error.index, 1);
        assert.equal(error.cause.message, 'slow failure');
        return true;
      },
    );
  });
});

describe('pool — abort', () => {
  it('stops picking up new items once the signal aborts', async () => {
    const controller = new AbortController();
    let started = 0;

    const results = await pool(range(50), async () => {
      started += 1;
      await sleep(5);
      if (started >= 4) controller.abort();
      return true;
    }, { concurrency: 2, signal: controller.signal });

    assert.ok(started < 50, `started ${started} of 50`);
    assert.ok(results.some((r) => r.status === 'skipped'));
  });

  it('marks unattempted items as skipped, never as rejected', async () => {
    const controller = new AbortController();
    controller.abort();

    const results = await pool(range(5), async () => 'never runs', {
      signal: controller.signal,
    });

    assert.deepEqual(
      results.map((r) => r.status),
      ['skipped', 'skipped', 'skipped', 'skipped', 'skipped'],
    );
  });
});

describe('partition', () => {
  it('splits results three ways, preserving input indices', async () => {
    const results = [
      { status: 'fulfilled', value: 'a' },
      { status: 'rejected', reason: new Error('x') },
      { status: 'skipped' },
      { status: 'fulfilled', value: 'd' },
    ];

    const { fulfilled, rejected, skipped } = partition(results);

    assert.deepEqual(fulfilled, [{ index: 0, value: 'a' }, { index: 3, value: 'd' }]);
    assert.deepEqual(rejected.map((r) => r.index), [1]);
    assert.deepEqual(skipped, [{ index: 2 }]);
  });

  it('handles an empty result set', () => {
    assert.deepEqual(partition([]), { fulfilled: [], rejected: [], skipped: [] });
  });
});

describe('TerminalClient.bulk', () => {
  function stubFetch({ failOn = () => false } = {}) {
    const calls = [];

    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const status = failOn(url) ? 500 : 200;

      return new Response(JSON.stringify({ url }), {
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

  it('signs and sends every request in the batch', async () => {
    const fetchImpl = stubFetch();
    const requests = range(6).map((i) => ({ method: 'GET', path: `/terminals/T-${i}` }));

    const results = await makeClient(fetchImpl).bulk(requests, { concurrency: 2 });

    assert.equal(fetchImpl.calls.length, 6);
    assert.ok(results.every((r) => r.status === 'fulfilled'));
  });

  it('defaults the method to GET', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).bulk([{ path: '/terminals' }]);

    assert.equal(fetchImpl.calls[0].init.method, 'GET');
  });

  it('keeps status and headers on each result', async () => {
    const fetchImpl = stubFetch();
    const [result] = await makeClient(fetchImpl).bulk([{ path: '/terminals' }]);

    assert.equal(result.value.status, 200);
    assert.equal(result.value.data.url, 'https://api.example.com/terminals');
  });

  it('isolates a failing request from the rest of the batch', async () => {
    const fetchImpl = stubFetch({ failOn: (url) => url.endsWith('T-2') });
    const requests = range(4).map((i) => ({ path: `/terminals/T-${i}` }));

    const results = await makeClient(fetchImpl).bulk(requests);
    const { fulfilled, rejected } = partition(results);

    assert.equal(fulfilled.length, 3);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].index, 2);
    assert.equal(rejected[0].reason.status, 500);
  });

  it('gives every request in the batch its own nonce', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).bulk(range(8).map((i) => ({ path: `/t/${i}` })));

    const nonces = fetchImpl.calls.map((call) => call.init.headers['x-nonce']);
    assert.equal(new Set(nonces).size, 8);
  });

  it('passes per-request options through to the signer', async () => {
    const fetchImpl = stubFetch();
    await makeClient(fetchImpl).bulk([
      { method: 'POST', path: '/terminals', body: { label: 'front desk' } },
    ]);

    assert.equal(fetchImpl.calls[0].init.method, 'POST');
    assert.equal(fetchImpl.calls[0].init.body, '{"label":"front desk"}');
  });
});
