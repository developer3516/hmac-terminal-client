import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TOLERANCE_MS,
  HEADER,
  buildCanonicalRequest,
  canonicalPath,
  canonicalQuery,
  computeSignature,
  constantTimeEquals,
  generateNonce,
  hashBody,
  rfc3986,
  signRequest,
  verifyRequest,
} from '../src/index.js';

const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';
const TIMESTAMP = 1_767_225_600; // 2026-01-01T00:00:00Z
const NONCE = 'ff00ff00ff00ff00ff00ff00ff00ff00';

/** Empty-string SHA-256 — the body hash when there is no body. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('rfc3986', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    assert.equal(rfc3986("!'()*"), '%21%27%28%29%2A');
  });

  it('leaves unreserved characters untouched', () => {
    assert.equal(rfc3986('aZ0-_.~'), 'aZ0-_.~');
  });

  it('encodes spaces as %20, never as +', () => {
    assert.equal(rfc3986('a b'), 'a%20b');
  });
});

describe('canonicalQuery', () => {
  it('is order-independent', () => {
    assert.equal(canonicalQuery({ b: 2, a: 1 }), canonicalQuery({ a: 1, b: 2 }));
    assert.equal(canonicalQuery({ a: 1, b: 2 }), 'a=1&b=2');
  });

  it('sorts repeated keys by value', () => {
    assert.equal(canonicalQuery({ tag: ['z', 'a', 'm'] }), 'tag=a&tag=m&tag=z');
  });

  it('drops undefined and null but keeps empty strings', () => {
    assert.equal(canonicalQuery({ a: undefined, b: null, c: '' }), 'c=');
  });

  it('treats an absent query and an empty object identically', () => {
    assert.equal(canonicalQuery(undefined), '');
    assert.equal(canonicalQuery({}), '');
  });

  it('accepts URLSearchParams and pair arrays', () => {
    const expected = 'a=1&b=2';
    assert.equal(canonicalQuery(new URLSearchParams([['b', '2'], ['a', '1']])), expected);
    assert.equal(canonicalQuery([['b', 2], ['a', 1]]), expected);
  });

  it('encodes reserved characters in both key and value', () => {
    assert.equal(canonicalQuery({ 'a b': 'c&d=e' }), 'a%20b=c%26d%3De');
  });
});

describe('canonicalPath', () => {
  it('adds a leading slash', () => {
    assert.equal(canonicalPath('terminals'), '/terminals');
  });

  it('is idempotent over already-encoded input', () => {
    const once = canonicalPath('/terminals/a b');
    assert.equal(once, '/terminals/a%20b');
    assert.equal(canonicalPath(once), once);
  });

  it('rejects an embedded query string rather than signing it as path', () => {
    assert.throws(() => canonicalPath('/terminals?limit=1'), /must not contain a query string/);
  });

  it('rejects a non-string path', () => {
    assert.throws(() => canonicalPath(''), /non-empty string/);
  });
});

describe('hashBody', () => {
  it('hashes a missing body as the empty string', () => {
    assert.equal(hashBody(undefined), EMPTY_SHA256);
    assert.equal(hashBody(null), EMPTY_SHA256);
    assert.equal(hashBody(''), EMPTY_SHA256);
  });

  it('hashes an object as its JSON encoding', () => {
    assert.equal(hashBody({ a: 1 }), hashBody('{"a":1}'));
  });

  it('is key-order sensitive, matching JSON.stringify on the wire', () => {
    assert.notEqual(hashBody({ a: 1, b: 2 }), hashBody({ b: 2, a: 1 }));
  });

  it('throws a typed error on a circular body', () => {
    const circular = {};
    circular.self = circular;
    assert.throws(() => hashBody(circular), /could not be JSON-serialised/);
  });
});

describe('buildCanonicalRequest', () => {
  const base = { method: 'get', path: '/terminals', timestamp: TIMESTAMP, nonce: NONCE };

  it('produces the documented seven-line layout', () => {
    const lines = buildCanonicalRequest(base).split('\n');
    assert.deepEqual(lines, ['v1', 'GET', '/terminals', '', String(TIMESTAMP), NONCE, EMPTY_SHA256]);
  });

  it('uppercases the method', () => {
    assert.equal(buildCanonicalRequest(base), buildCanonicalRequest({ ...base, method: 'GET' }));
  });

  it('rejects a non-integer timestamp', () => {
    assert.throws(() => buildCanonicalRequest({ ...base, timestamp: 1.5 }), /integer/);
  });

  it('rejects an empty nonce', () => {
    assert.throws(() => buildCanonicalRequest({ ...base, nonce: '' }), /nonce/);
  });
});

describe('computeSignature', () => {
  it('rejects an empty secret instead of signing with one', () => {
    assert.throws(() => computeSignature('', 'canonical'), /must not be empty/);
  });

  it('rejects a non-string, non-Buffer secret', () => {
    assert.throws(() => computeSignature(123, 'canonical'), /string or Buffer/);
  });

  it('accepts a Buffer secret and matches the string form', () => {
    assert.equal(computeSignature(Buffer.from(SECRET), 'x'), computeSignature(SECRET, 'x'));
  });
});

describe('signRequest', () => {
  const sign = (overrides = {}) =>
    signRequest({
      keyId: KEY_ID,
      secret: SECRET,
      method: 'POST',
      path: '/terminals/T-1/capture',
      query: { dryRun: true },
      body: { amount: 1250, currency: 'AUD' },
      timestamp: TIMESTAMP,
      nonce: NONCE,
      ...overrides,
    });

  it('is deterministic for a fixed timestamp and nonce', () => {
    assert.equal(sign().signature, sign().signature);
  });

  it('emits every header the scheme requires', () => {
    const { headers } = sign();
    assert.deepEqual(Object.keys(headers).sort(), Object.values(HEADER).sort());
    assert.equal(headers[HEADER.keyId], KEY_ID);
    assert.equal(headers[HEADER.version], 'v1');
    assert.match(headers[HEADER.signature], /^[0-9a-f]{64}$/);
  });

  it('never puts the secret in the headers', () => {
    assert.ok(!JSON.stringify(sign().headers).includes(SECRET));
  });

  it('changes the signature when any signed component changes', () => {
    const baseline = sign().signature;
    assert.notEqual(sign({ method: 'PUT' }).signature, baseline);
    assert.notEqual(sign({ path: '/terminals/T-2/capture' }).signature, baseline);
    assert.notEqual(sign({ query: { dryRun: false } }).signature, baseline);
    assert.notEqual(sign({ body: { amount: 1251, currency: 'AUD' } }).signature, baseline);
    assert.notEqual(sign({ timestamp: TIMESTAMP + 1 }).signature, baseline);
    assert.notEqual(sign({ nonce: 'a'.repeat(32) }).signature, baseline);
    assert.notEqual(sign({ secret: `${SECRET}!` }).signature, baseline);
  });

  it('defaults the timestamp to now and the nonce to a fresh value', () => {
    const a = signRequest({ keyId: KEY_ID, secret: SECRET, method: 'GET', path: '/ping' });
    const b = signRequest({ keyId: KEY_ID, secret: SECRET, method: 'GET', path: '/ping' });

    assert.notEqual(a.nonce, b.nonce);
    assert.ok(Math.abs(a.timestamp - Math.floor(Date.now() / 1000)) <= 1);
  });

  it('rejects a missing keyId', () => {
    assert.throws(() => sign({ keyId: '' }), /keyId/);
  });
});

describe('verifyRequest', () => {
  const request = {
    method: 'POST',
    path: '/terminals/T-1/capture',
    query: { dryRun: true },
    body: { amount: 1250, currency: 'AUD' },
  };

  const signed = signRequest({
    keyId: KEY_ID,
    secret: SECRET,
    ...request,
    timestamp: TIMESTAMP,
    nonce: NONCE,
  });

  const verify = (overrides = {}) =>
    verifyRequest({
      secret: SECRET,
      headers: signed.headers,
      ...request,
      now: TIMESTAMP * 1000,
      ...overrides,
    });

  it('accepts a request signed with the same secret', () => {
    assert.deepEqual(verify(), { valid: true, reason: null, timestamp: TIMESTAMP, nonce: NONCE });
  });

  it('accepts a Headers instance as well as a plain object', () => {
    assert.equal(verify({ headers: new Headers(signed.headers) }).valid, true);
  });

  it('is insensitive to header name casing', () => {
    const upper = Object.fromEntries(
      Object.entries(signed.headers).map(([key, value]) => [key.toUpperCase(), value]),
    );
    assert.equal(verify({ headers: upper }).valid, true);
  });

  it('rejects a tampered body', () => {
    const result = verify({ body: { amount: 999_999, currency: 'AUD' } });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'signature mismatch');
  });

  it('rejects a tampered query', () => {
    assert.equal(verify({ query: { dryRun: false } }).valid, false);
  });

  it('rejects a swapped method', () => {
    assert.equal(verify({ method: 'DELETE' }).valid, false);
  });

  it('rejects the wrong secret', () => {
    assert.equal(verify({ secret: 'not-the-secret' }).valid, false);
  });

  it('rejects a stale timestamp outside the tolerance', () => {
    const result = verify({ now: (TIMESTAMP + 3600) * 1000 });
    assert.equal(result.valid, false);
    assert.match(result.reason, /outside tolerance/);
  });

  it('rejects a timestamp too far in the future, not just the past', () => {
    assert.equal(verify({ now: (TIMESTAMP - 3600) * 1000 }).valid, false);
  });

  it('accepts a timestamp at the edge of the tolerance window', () => {
    assert.equal(verify({ now: TIMESTAMP * 1000 + DEFAULT_TOLERANCE_MS }).valid, true);
  });

  it('names each missing header rather than failing generically', () => {
    for (const [field, pattern] of [
      [HEADER.signature, /missing signature/],
      [HEADER.nonce, /missing nonce/],
      [HEADER.timestamp, /missing timestamp/],
    ]) {
      const headers = { ...signed.headers };
      delete headers[field];
      assert.match(verify({ headers }).reason, pattern);
    }
  });

  it('rejects an unknown signature version', () => {
    const headers = { ...signed.headers, [HEADER.version]: 'v2' };
    assert.match(verify({ headers }).reason, /unsupported signature version: v2/);
  });

  it('rejects a non-integer timestamp header', () => {
    const headers = { ...signed.headers, [HEADER.timestamp]: 'yesterday' };
    assert.match(verify({ headers }).reason, /not an integer/);
  });

  it('round-trips a body with unicode and reserved characters', () => {
    const tricky = { note: 'café & co — 100% ✅', path: 'a/b?c=d' };
    const fresh = signRequest({ keyId: KEY_ID, secret: SECRET, method: 'POST', path: '/notes', body: tricky });

    const result = verifyRequest({
      secret: SECRET,
      headers: fresh.headers,
      method: 'POST',
      path: '/notes',
      body: tricky,
    });

    assert.equal(result.valid, true);
  });
});

describe('constantTimeEquals', () => {
  it('is true only for identical strings', () => {
    assert.equal(constantTimeEquals('abc', 'abc'), true);
    assert.equal(constantTimeEquals('abc', 'abd'), false);
  });

  it('returns false on a length mismatch instead of throwing', () => {
    assert.equal(constantTimeEquals('abc', 'abcd'), false);
  });

  it('returns false for non-string input', () => {
    assert.equal(constantTimeEquals(undefined, 'abc'), false);
    assert.equal(constantTimeEquals('abc', null), false);
  });
});

describe('generateNonce', () => {
  it('returns 128 bits of hex', () => {
    assert.match(generateNonce(), /^[0-9a-f]{32}$/);
  });

  it('does not repeat across a sample', () => {
    const sample = new Set(Array.from({ length: 1000 }, generateNonce));
    assert.equal(sample.size, 1000);
  });
});
