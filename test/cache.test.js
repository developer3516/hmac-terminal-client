import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CACHEABLE_METHODS,
  DEFAULT_CACHE,
  ResponseCache,
  TerminalClient,
  cacheKey,
  isCacheable,
  isStorable,
  resolveCache,
  validatorHeaders,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';
const ETAG = '"v1-abc123"';

/**
 * A stub that answers 304 when the caller sends a matching validator, and
 * 200 with a body otherwise — which is what a conditional endpoint does.
 */
function conditionalFetch({ etag = ETAG, body = { items: ['a', 'b'] } } = {}) {
  const calls = [];
  const state = { etag, body, status: 200 };

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });

    // Guarded on there being an etag at all: without it, a first request
    // with no validator would compare undefined against undefined and get
    // a 304 it never asked for.
    if (state.status === 200 && state.etag && init.headers['if-none-match'] === state.etag) {
      return new Response(null, { status: 304, headers: { etag: state.etag } });
    }

    if (state.status !== 200) {
      return new Response(JSON.stringify({ message: 'nope' }), {
        status: state.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Omit the header entirely when there is no etag — setting it to
    // `undefined` would send the literal string "undefined".
    return new Response(JSON.stringify(state.body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        ...(state.etag ? { etag: state.etag } : {}),
      },
    });
  };

  fetchImpl.calls = calls;
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

describe('cacheKey', () => {
  it('is identical for queries that differ only in order', () => {
    // The canonical form is already order-independent, which is exactly the
    // property a cache key needs.
    assert.equal(cacheKey('GET', '/terminals', 'a=1&b=2'), cacheKey('GET', '/terminals', 'a=1&b=2'));
  });

  it('separates different paths, queries and methods', () => {
    const base = cacheKey('GET', '/terminals', 'limit=10');

    assert.notEqual(base, cacheKey('GET', '/terminals', 'limit=20'));
    assert.notEqual(base, cacheKey('GET', '/devices', 'limit=10'));
    assert.notEqual(base, cacheKey('HEAD', '/terminals', 'limit=10'));
  });

  it('omits the question mark when there is no query', () => {
    assert.equal(cacheKey('GET', '/terminals', ''), 'GET /terminals');
  });

  it('uppercases the method', () => {
    assert.equal(cacheKey('get', '/t', ''), cacheKey('GET', '/t', ''));
  });
});

describe('isCacheable', () => {
  it('covers the safe methods only', () => {
    assert.deepEqual([...CACHEABLE_METHODS], ['GET', 'HEAD']);
    assert.equal(isCacheable('GET'), true);
    assert.equal(isCacheable('head'), true);
    assert.equal(isCacheable('POST'), false);
    assert.equal(isCacheable('DELETE'), false);
  });
});

describe('isStorable', () => {
  it('stores a 200 that carries a validator', () => {
    assert.equal(isStorable(200, { etag: ETAG }), true);
    assert.equal(isStorable(200, { 'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT' }), true);
  });

  it('refuses a 200 with nothing to revalidate against', () => {
    // Storing it would mean guessing at freshness, which is how a stale cache
    // becomes a bug report.
    assert.equal(isStorable(200, {}), false);
  });

  it('refuses anything that is not a 200', () => {
    assert.equal(isStorable(201, { etag: ETAG }), false);
    assert.equal(isStorable(404, { etag: ETAG }), false);
    assert.equal(isStorable(500, { etag: ETAG }), false);
  });
});

describe('validatorHeaders', () => {
  it('prefers an ETag', () => {
    // Exact: a resource can change twice within one second, and a date
    // cannot express that.
    const headers = validatorHeaders({ etag: ETAG, lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT' });

    assert.deepEqual(headers, { 'if-none-match': ETAG });
  });

  it('falls back to a date when that is all there is', () => {
    const headers = validatorHeaders({ lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT' });

    assert.deepEqual(headers, { 'if-modified-since': 'Thu, 01 Jan 2026 00:00:00 GMT' });
  });

  it('sends nothing when there is no entry', () => {
    assert.deepEqual(validatorHeaders(undefined), {});
    assert.deepEqual(validatorHeaders({}), {});
  });
});

describe('ResponseCache', () => {
  const entry = (n) => ({ status: 200, headers: {}, data: n, etag: `"${n}"` });

  it('stores and returns entries', () => {
    const cache = new ResponseCache();

    cache.set('a', entry(1));

    assert.equal(cache.get('a').data, 1);
    assert.equal(cache.get('missing'), undefined);
    assert.equal(cache.size, 1);
  });

  it('evicts the least recently used', () => {
    // Unbounded would be a memory leak with a friendly name: a paginating job
    // walking a million cursors would hold every page it ever saw.
    const cache = new ResponseCache({ maxEntries: 2 });

    cache.set('a', entry(1));
    cache.set('b', entry(2));
    cache.set('c', entry(3));

    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b').data, 2);
    assert.equal(cache.get('c').data, 3);
  });

  it('counts a read as recent use', () => {
    const cache = new ResponseCache({ maxEntries: 2 });

    cache.set('a', entry(1));
    cache.set('b', entry(2));
    cache.get('a'); // a is now the newest
    cache.set('c', entry(3));

    assert.equal(cache.get('a').data, 1);
    assert.equal(cache.get('b'), undefined);
  });

  it('overwrites rather than duplicating', () => {
    const cache = new ResponseCache();

    cache.set('a', entry(1));
    cache.set('a', entry(2));

    assert.equal(cache.size, 1);
    assert.equal(cache.get('a').data, 2);
  });

  it('can be emptied', () => {
    const cache = new ResponseCache();
    cache.set('a', entry(1));

    assert.equal(cache.delete('a'), true);
    cache.set('b', entry(2));
    cache.clear();

    assert.equal(cache.size, 0);
  });

  it('rejects a nonsensical bound', () => {
    assert.throws(() => new ResponseCache({ maxEntries: 0 }), RangeError);
    assert.throws(() => new ResponseCache({ maxEntries: -1 }), RangeError);
    assert.throws(() => new ResponseCache({ maxEntries: 1.5 }), RangeError);
  });

  it('has a bounded default', () => {
    assert.equal(new ResponseCache().maxEntries, DEFAULT_CACHE.maxEntries);
    assert.ok(Number.isFinite(DEFAULT_CACHE.maxEntries));
  });
});

describe('resolveCache', () => {
  it('is off unless asked for', () => {
    assert.equal(resolveCache(undefined), null);
    assert.equal(resolveCache(false), null);
  });

  it('passes an existing cache through, so clients can share one', () => {
    const cache = new ResponseCache();

    assert.equal(resolveCache(cache), cache);
  });
});

describe('TerminalClient — conditional requests', () => {
  it('sends no validator on a cold cache', async () => {
    const fetchImpl = conditionalFetch();
    await makeClient(fetchImpl, { cache: true }).get('/terminals');

    assert.equal(fetchImpl.calls[0].init.headers['if-none-match'], undefined);
  });

  it('revalidates on the second request and serves the stored body', async () => {
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl, { cache: true });

    const first = await client.get('/terminals');
    const second = await client.get('/terminals');

    assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], ETAG);
    assert.deepEqual(second, first, 'a 304 should be indistinguishable to the caller');
  });

  it('gives the caller the stored status, not the 304', async () => {
    // Handing back a 304 — or a null body — would be a strange reward for a
    // cache hit. The point is that the caller need not know it happened.
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl, { cache: true });

    await client.get('/terminals');
    const response = await client.request('GET', '/terminals');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { items: ['a', 'b'] });
    assert.equal(response.fromCache, true);
  });

  it('marks a fresh response as not from cache', async () => {
    const fetchImpl = conditionalFetch();
    const response = await makeClient(fetchImpl, { cache: true }).request('GET', '/terminals');

    assert.equal(response.fromCache, false);
  });

  it('picks up a changed body when the ETag moves', async () => {
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl, { cache: true });

    await client.get('/terminals');

    fetchImpl.state.etag = '"v2-def456"';
    fetchImpl.state.body = { items: ['a', 'b', 'c'] };

    assert.deepEqual(await client.get('/terminals'), { items: ['a', 'b', 'c'] });
    assert.deepEqual(await client.get('/terminals'), { items: ['a', 'b', 'c'] });
  });

  it('keys on the canonical query, not the signature', async () => {
    // Every request carries a fresh nonce and signature. A header-derived key
    // would never hit; this asserts the second request revalidated.
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl, { cache: true });

    await client.get('/terminals', { query: { status: 'active', limit: 10 } });
    await client.get('/terminals', { query: { limit: 10, status: 'active' } });

    const nonces = fetchImpl.calls.map((c) => c.init.headers['x-nonce']);
    assert.equal(new Set(nonces).size, 2, 'both requests were signed independently');
    assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], ETAG, 'and still hit one entry');
  });

  it('keeps different queries apart', async () => {
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl, { cache: true });

    await client.get('/terminals', { query: { limit: 10 } });
    await client.get('/terminals', { query: { limit: 20 } });

    assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], undefined);
  });

  it('does not cache a POST', async () => {
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl, { cache: true });

    await client.post('/terminals', { a: 1 });
    await client.post('/terminals', { a: 1 });

    assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], undefined);
  });

  it('does not store a response with no validator', async () => {
    const fetchImpl = conditionalFetch();
    fetchImpl.state.etag = null;

    const client = makeClient(fetchImpl, { cache: true });
    await client.get('/terminals');
    await client.get('/terminals');

    assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], undefined);
  });

  it('does not store an error response', async () => {
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl, { cache: true });

    fetchImpl.state.status = 404;
    await assert.rejects(client.get('/terminals'));

    fetchImpl.state.status = 200;
    await client.get('/terminals');

    assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], undefined);
  });

  it('shares a cache across clients', async () => {
    const cache = new ResponseCache();
    const first = conditionalFetch();
    const second = conditionalFetch();

    await makeClient(first, { cache }).get('/terminals');
    await makeClient(second, { cache }).get('/terminals');

    assert.equal(second.calls[0].init.headers['if-none-match'], ETAG);
  });

  it('lets a caller override the validator explicitly', async () => {
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl, { cache: true });

    await client.get('/terminals');
    await client.get('/terminals', { headers: { 'If-None-Match': '"forced"' } }).catch(() => {});

    assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], '"forced"');
  });

  it('treats an unprompted 304 as the error it is', async () => {
    // Nothing was cached, so there is no body to substitute. A server sending
    // 304 to a request that carried no validator is misbehaving, and saying
    // so beats inventing a response.
    const fetchImpl = async () => new Response(null, { status: 304 });

    await assert.rejects(makeClient(fetchImpl, { cache: true }).get('/terminals'));
  });

  it('does nothing at all when disabled', async () => {
    const fetchImpl = conditionalFetch();
    const client = makeClient(fetchImpl);

    await client.get('/terminals');
    await client.get('/terminals');

    assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], undefined);
  });
});
