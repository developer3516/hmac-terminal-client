import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PaginationError,
  TerminalClient,
  defaultCursorFrom,
  defaultItemsFrom,
  paginate,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';

const collect = async (iterable) => {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
};

describe('defaultCursorFrom', () => {
  it('recognises the shapes APIs actually use', () => {
    assert.equal(defaultCursorFrom({ next_cursor: 'a' }), 'a');
    assert.equal(defaultCursorFrom({ nextCursor: 'b' }), 'b');
    assert.equal(defaultCursorFrom({ next: 'c' }), 'c');
    assert.equal(defaultCursorFrom({ cursor: 'd' }), 'd');
  });

  it('prefers the more specific key when several are present', () => {
    assert.equal(defaultCursorFrom({ cursor: 'old', next_cursor: 'new' }), 'new');
  });

  it('treats absent, null and empty as the end', () => {
    assert.equal(defaultCursorFrom({}), null);
    assert.equal(defaultCursorFrom({ next_cursor: null }), null);
    assert.equal(defaultCursorFrom({ next_cursor: '' }), null);
    assert.equal(defaultCursorFrom(undefined), null);
    assert.equal(defaultCursorFrom('a string'), null);
  });

  it('keeps a zero cursor, which is a legitimate offset', () => {
    assert.equal(defaultCursorFrom({ next_cursor: 0 }), 0);
  });
});

describe('defaultItemsFrom', () => {
  it('unwraps the common container keys', () => {
    assert.deepEqual(defaultItemsFrom({ items: [1] }), [1]);
    assert.deepEqual(defaultItemsFrom({ data: [2] }), [2]);
    assert.deepEqual(defaultItemsFrom({ results: [3] }), [3]);
  });

  it('passes a bare array straight through', () => {
    assert.deepEqual(defaultItemsFrom([1, 2]), [1, 2]);
  });

  it('returns empty rather than throwing on an unfamiliar shape', () => {
    assert.deepEqual(defaultItemsFrom({ nope: 1 }), []);
    assert.deepEqual(defaultItemsFrom(null), []);
  });
});

describe('paginate', () => {
  /** Serve `pages`, handing out the next index as the cursor. */
  function server(pages) {
    const calls = [];

    const fetchPage = async (cursor) => {
      calls.push(cursor);
      const index = cursor === undefined ? 0 : Number(cursor);
      const last = index === pages.length - 1;

      return { items: pages[index], next_cursor: last ? null : String(index + 1) };
    };

    fetchPage.calls = calls;
    return fetchPage;
  }

  it('walks every page and stops when the cursor runs out', async () => {
    const fetchPage = server([['a'], ['b'], ['c']]);
    const pages = await collect(paginate(fetchPage));

    assert.equal(pages.length, 3);
    assert.deepEqual(fetchPage.calls, [undefined, '1', '2']);
  });

  it('handles a single page with no cursor at all', async () => {
    const pages = await collect(paginate(async () => ({ items: ['only'] })));

    assert.equal(pages.length, 1);
  });

  it('is lazy — breaking early stops the requests', async () => {
    const fetchPage = server([['a'], ['b'], ['c'], ['d'], ['e']]);

    for await (const page of paginate(fetchPage)) {
      if (page.items[0] === 'b') break;
    }

    // Two pages fetched, not five. The whole point of the iterator.
    assert.equal(fetchPage.calls.length, 2);
  });

  it('accepts a custom cursor extractor', async () => {
    let n = 0;
    const pages = await collect(
      paginate(async () => ({ page: n, more: n++ < 2 }), {
        cursorFrom: (p) => (p.more ? p.page + 1 : null),
      }),
    );

    assert.equal(pages.length, 3);
  });

  it('rejects a non-function page fetcher', async () => {
    await assert.rejects(collect(paginate('not a function')), TypeError);
  });
});

describe('paginate — runaway protection', () => {
  it('stops when the server hands back a cursor it already gave', async () => {
    // A misconfigured endpoint echoing its own cursor turns a naive loop into
    // an unkillable request flood.
    let calls = 0;
    const stuck = async () => {
      calls += 1;
      return { items: ['x'], next_cursor: 'same-every-time' };
    };

    await assert.rejects(collect(paginate(stuck)), (error) => {
      assert.ok(error instanceof PaginationError);
      assert.match(error.message, /looped/);
      assert.equal(error.cursor, 'same-every-time');
      return true;
    });

    // Caught on the second page, not after thousands.
    assert.equal(calls, 2);
  });

  it('detects a longer cycle, not just an immediate repeat', async () => {
    const cycle = ['1', '2', '3', '1'];
    let i = 0;
    const looping = async () => ({ items: [], next_cursor: cycle[i++ % cycle.length] });

    await assert.rejects(collect(paginate(looping)), PaginationError);
  });

  it('detects a loop through an object cursor', async () => {
    const looping = async () => ({ items: [], next_cursor: { page: 1, token: 'x' } });

    await assert.rejects(collect(paginate(looping)), /looped/);
  });

  it('throws rather than truncating when maxPages is reached', async () => {
    // Silent truncation would look exactly like a complete result set, which
    // is the worst way for this to fail.
    const endless = async (cursor) => ({ items: [], next_cursor: String(Number(cursor ?? 0) + 1) });

    await assert.rejects(collect(paginate(endless, { maxPages: 3 })), (error) => {
      assert.ok(error instanceof PaginationError);
      assert.match(error.message, /3-page limit/);
      assert.equal(error.pages, 3);
      return true;
    });
  });

  it('does not trip maxPages when the walk ends on its own', async () => {
    const fetchPage = async (cursor) =>
      cursor === undefined ? { items: ['a'], next_cursor: '1' } : { items: ['b'] };

    assert.equal((await collect(paginate(fetchPage, { maxPages: 2 }))).length, 2);
  });

  it('reports a loop as a loop even when maxPages would also trip', async () => {
    const stuck = async () => ({ items: [], next_cursor: 'same' });

    await assert.rejects(collect(paginate(stuck, { maxPages: 2 })), /looped/);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const endless = async (cursor) => {
      if (Number(cursor ?? 0) >= 2) controller.abort();
      return { items: [], next_cursor: String(Number(cursor ?? 0) + 1) };
    };

    await assert.rejects(collect(paginate(endless, { signal: controller.signal })));
  });
});

describe('TerminalClient.paginate', () => {
  /** A stub serving `pages`, reading the cursor from `param`. */
  function stubFetch(pages, param = 'cursor') {
    const calls = [];

    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const cursor = new URL(url).searchParams.get(param);
      const index = cursor === null ? 0 : Number(cursor);
      const last = index === pages.length - 1;

      return new Response(
        JSON.stringify({ items: pages[index], next_cursor: last ? null : String(index + 1) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
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

  it('yields one page per request', async () => {
    const fetchImpl = stubFetch([['a'], ['b'], ['c']]);
    const pages = await collect(makeClient(fetchImpl).paginate('/terminals'));

    assert.equal(pages.length, 3);
    assert.equal(pages[0].status, 200);
    assert.deepEqual(pages[1].data.items, ['b']);
  });

  it('finds the cursor in the payload, not the response wrapper', async () => {
    // The wrapper has no `next_cursor`; only `data` does. Reading the wrong
    // level would silently stop after one page.
    const fetchImpl = stubFetch([['a'], ['b']]);

    assert.equal((await collect(makeClient(fetchImpl).paginate('/terminals'))).length, 2);
  });

  it('carries the cursor in the query and keeps the caller query too', async () => {
    const fetchImpl = stubFetch([['a'], ['b']]);
    await collect(makeClient(fetchImpl).paginate('/terminals', { query: { limit: 100 } }));

    assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/terminals?limit=100');
    assert.equal(fetchImpl.calls[1].url, 'https://api.example.com/terminals?cursor=1&limit=100');
  });

  it('honours a custom cursor parameter name', async () => {
    const fetchImpl = stubFetch([['a'], ['b']], 'page_token');
    await collect(makeClient(fetchImpl).paginate('/terminals', { cursorParam: 'page_token' }));

    assert.match(fetchImpl.calls[1].url, /page_token=1/);
  });

  it('signs each page afresh', async () => {
    // A walk over hundreds of pages outlives any single signature's tolerance
    // window, so reusing one would start failing partway through.
    const fetchImpl = stubFetch([['a'], ['b'], ['c']]);
    await collect(makeClient(fetchImpl).paginate('/terminals'));

    const nonces = fetchImpl.calls.map((c) => c.init.headers['x-nonce']);
    assert.equal(new Set(nonces).size, 3);
  });

  it('flattens to items with paginateItems', async () => {
    const fetchImpl = stubFetch([['a', 'b'], ['c'], ['d', 'e']]);
    const items = await collect(makeClient(fetchImpl).paginateItems('/terminals'));

    assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e']);
  });

  it('accepts a custom item extractor', async () => {
    const fetchImpl = stubFetch([[{ id: 1 }], [{ id: 2 }]]);
    const items = await collect(
      makeClient(fetchImpl).paginateItems('/terminals', { itemsFrom: (d) => d.items.map((t) => t.id) }),
    );

    assert.deepEqual(items, [1, 2]);
  });

  it('propagates an API error instead of ending the walk quietly', async () => {
    const fetchImpl = async () =>
      new Response('{"message":"boom"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });

    await assert.rejects(collect(makeClient(fetchImpl).paginate('/terminals')), /boom/);
  });

  it('stops fetching once the caller breaks out', async () => {
    const fetchImpl = stubFetch([['a'], ['b'], ['c'], ['d']]);

    for await (const item of makeClient(fetchImpl).paginateItems('/terminals')) {
      if (item === 'b') break;
    }

    assert.equal(fetchImpl.calls.length, 2);
  });
});
