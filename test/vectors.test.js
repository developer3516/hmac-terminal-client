import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildCanonicalRequest,
  computeSignature,
  hashBody,
  signRequest,
  verifyRequest,
} from '../src/index.js';

/**
 * Validate the implementation against the committed conformance vectors.
 *
 * The direction matters: this reads the file and checks the code reproduces
 * it, never the other way round. Regenerating inside the test would make the
 * whole thing circular — it would pass no matter what the signing did.
 *
 * So a change to the canonical form fails here, loudly, with a diff of the
 * exact string that changed. That is the intent: the committed file *is* the
 * wire format, and changing it breaks every integration that already exists.
 */
const document = JSON.parse(
  readFileSync(new URL('../vectors/v1.json', import.meta.url), 'utf8'),
);

const { secret, keyId, vectors } = document;

describe('conformance vectors — the document', () => {
  it('declares the scheme it pins', () => {
    assert.equal(document.scheme, 'v1');
    assert.equal(document.algorithm, 'HMAC-SHA256');
    assert.equal(document.encoding, 'lowercase hex');
  });

  it('carries enough vectors to be worth the name', () => {
    assert.ok(vectors.length >= 12, `only ${vectors.length} vectors`);
  });

  it('names every vector uniquely', () => {
    const names = vectors.map((v) => v.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('says what each vector catches', () => {
    // The field exists for whoever is debugging a mismatch: it tells them
    // what their implementation probably got wrong, which beats a bad hash.
    for (const vector of vectors) {
      assert.ok(vector.catches?.length > 10, `${vector.name} has no explanation`);
    }
  });

  it('uses a secret that cannot be mistaken for a real one', () => {
    assert.match(secret, /do-not-use-in-production/);
  });
});

describe('conformance vectors — the implementation matches', () => {
  for (const vector of vectors) {
    describe(vector.name, () => {
      const { method, path, query, body } = vector.request;
      const input = {
        method,
        path,
        query: query ?? undefined,
        body: body ?? undefined,
        timestamp: vector.timestamp,
        nonce: vector.nonce,
      };

      it('reproduces the canonical request byte for byte', () => {
        assert.equal(buildCanonicalRequest(input), vector.canonicalRequest);
      });

      it('reproduces the body hash', () => {
        assert.equal(hashBody(body ?? undefined), vector.bodySha256);
      });

      it('reproduces the signature', () => {
        assert.equal(computeSignature(secret, vector.canonicalRequest), vector.signature);
      });

      it('produces the same signature through signRequest', () => {
        const signed = signRequest({ keyId, secret, ...input });

        assert.equal(signed.signature, vector.signature);
        assert.equal(signed.headers['x-signature'], vector.signature);
      });

      it('verifies against itself', () => {
        const signed = signRequest({ keyId, secret, ...input });
        const result = verifyRequest({
          secret,
          headers: signed.headers,
          method,
          path,
          query: query ?? undefined,
          body: body ?? undefined,
          now: vector.timestamp * 1000,
        });

        assert.equal(result.valid, true, result.reason ?? '');
      });
    });
  }
});

describe('conformance vectors — the cases that matter', () => {
  const byName = Object.fromEntries(vectors.map((v) => [v.name, v]));
  const line = (vector, index) => vector.canonicalRequest.split('\n')[index];

  it('sorts the query rather than preserving insertion order', () => {
    // Input was status, limit, cursor.
    assert.equal(line(byName['query-sorted-by-key'], 3), 'cursor=abc&limit=10&status=active');
  });

  it('sorts repeated keys by value', () => {
    assert.equal(line(byName['query-repeated-key-sorted-by-value'], 3), 'tag=a&tag=m&tag=z');
  });

  it("encodes !'()*, which encodeURIComponent leaves alone", () => {
    assert.equal(line(byName['query-rfc3986-characters'], 3), 'q=%21%27%28%29%2A');
  });

  it('encodes a space as %20, never as +', () => {
    const encoded = line(byName['query-space-is-percent-twenty'], 3);

    assert.equal(encoded, 'q=front%20desk');
    assert.ok(!encoded.includes('+'));
  });

  it('encodes reserved characters in both key and value', () => {
    assert.equal(line(byName['query-reserved-characters'], 3), 'a%20b=c%26d%3De');
  });

  it('keeps an empty value as a parameter', () => {
    assert.equal(line(byName['query-empty-value-kept'], 3), 'cursor=&limit=10');
  });

  it('encodes path segments without encoding the separators', () => {
    assert.equal(line(byName['path-encoded-segment'], 2), '/terminals/front%20desk/status');
  });

  it('uppercases a lowercase method', () => {
    assert.equal(line(byName['method-lowercase-input'], 1), 'DELETE');
  });

  it('hashes an empty body the same as no body', () => {
    assert.equal(byName['post-empty-body-string'].bodySha256, byName['get-no-query-no-body'].bodySha256);
  });

  it('gives the same JSON object a different hash when the keys are reordered', () => {
    // Same two fields, same two values, opposite order. Parsed they are
    // identical; signed they are not, and an implementation that
    // re-serialises before hashing will fail exactly here.
    const a = byName['post-json-body'];
    const b = byName['post-json-body-key-order-differs'];

    assert.deepEqual(JSON.parse(a.request.body), JSON.parse(b.request.body));
    assert.notEqual(a.bodySha256, b.bodySha256);
    assert.notEqual(a.signature, b.signature);
  });

  it('gives every vector a distinct signature', () => {
    // If two differed only in something the canonical form ignores, they
    // would collide — and the vector would be testing nothing.
    const signatures = vectors.map((v) => v.signature);

    assert.equal(new Set(signatures).size, signatures.length);
  });
});

describe('conformance vectors — tampering', () => {
  const vector = vectors.find((v) => v.name === 'put-with-query-and-body');

  const verify = (overrides) =>
    verifyRequest({
      secret,
      headers: signRequest({
        keyId,
        secret,
        method: vector.request.method,
        path: vector.request.path,
        query: vector.request.query,
        body: vector.request.body,
        timestamp: vector.timestamp,
        nonce: vector.nonce,
      }).headers,
      method: vector.request.method,
      path: vector.request.path,
      query: vector.request.query,
      body: vector.request.body,
      now: vector.timestamp * 1000,
      ...overrides,
    });

  it('accepts the untouched request', () => {
    assert.equal(verify({}).valid, true);
  });

  it('rejects a changed method, path, query and body', () => {
    assert.equal(verify({ method: 'POST' }).valid, false);
    assert.equal(verify({ path: '/terminals/T-2' }).valid, false);
    assert.equal(verify({ query: { force: 'false' } }).valid, false);
    assert.equal(verify({ body: '{"label":"back office"}' }).valid, false);
  });

  it('rejects the wrong secret', () => {
    assert.equal(verify({ secret: `${secret}!` }).valid, false);
  });
});
