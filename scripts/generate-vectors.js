#!/usr/bin/env node

/**
 * Regenerate `vectors/v1.json`.
 *
 * The vectors exist because a signing scheme is only useful if two independent
 * implementations agree, and "read the README carefully" is not a mechanism.
 * A server team writing the Python or Go half can load this file, feed each
 * case through their own code, and compare — no live endpoint, no guessing at
 * which of the two sides is wrong.
 *
 * The cases are chosen to be exactly the places two implementations can
 * plausibly diverge. A vector for the happy path proves very little; a vector
 * for `!'()*` proves whether someone reached for `encodeURIComponent`.
 *
 * Regenerating is a deliberate act. If the committed file changes, the wire
 * format changed, and every existing integration breaks — so the diff is the
 * warning, and it should be read rather than waved through.
 *
 * Usage: npm run vectors
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildCanonicalRequest, computeSignature, hashBody } from '../src/index.js';

const SECRET = 'conformance-secret-do-not-use-in-production';
const KEY_ID = 'ak_test_conformance';
const TIMESTAMP = 1_767_225_600; // 2026-01-01T00:00:00Z
const NONCE = 'ff00ff00ff00ff00ff00ff00ff00ff00';

/**
 * Each case names the disagreement it exists to catch. The `catches` field is
 * for whoever is debugging a mismatch: it tells them what their code probably
 * got wrong, which is more useful than a failing hash.
 */
const CASES = [
  {
    name: 'get-no-query-no-body',
    catches: 'baseline — the empty query line and the empty-body hash must both be present',
    method: 'GET',
    path: '/terminals',
  },
  {
    name: 'query-sorted-by-key',
    catches: 'query parameters must sort, not follow insertion order',
    method: 'GET',
    path: '/terminals',
    query: { status: 'active', limit: '10', cursor: 'abc' },
  },
  {
    name: 'query-repeated-key-sorted-by-value',
    catches: 'repeated keys sort by value, not by the order supplied',
    method: 'GET',
    path: '/terminals',
    query: { tag: ['z', 'a', 'm'] },
  },
  {
    name: 'query-rfc3986-characters',
    catches: "encodeURIComponent leaves !'()* raw — RFC 3986 does not",
    method: 'GET',
    path: '/search',
    query: { q: "!'()*" },
  },
  {
    name: 'query-space-is-percent-twenty',
    catches: 'form encoding would emit + for a space',
    method: 'GET',
    path: '/search',
    query: { q: 'front desk' },
  },
  {
    name: 'query-reserved-characters',
    catches: '& and = inside a value must be encoded, in both key and value',
    method: 'GET',
    path: '/search',
    query: { 'a b': 'c&d=e' },
  },
  {
    name: 'query-empty-value-kept',
    catches: 'an empty string is a parameter; undefined and null are not',
    method: 'GET',
    path: '/terminals',
    query: { cursor: '', limit: '10' },
  },
  {
    name: 'query-unicode-value',
    catches: 'non-ASCII must be UTF-8 encoded before percent-encoding',
    method: 'GET',
    path: '/search',
    query: { q: 'café ✅' },
  },
  {
    name: 'path-encoded-segment',
    catches: 'each path segment is encoded, and the slashes between them are not',
    method: 'GET',
    path: '/terminals/front desk/status',
  },
  {
    name: 'path-with-base-prefix',
    catches: 'a base URL path prefix is part of the signed path',
    method: 'GET',
    path: '/v2/terminals',
  },
  {
    name: 'post-json-body',
    catches: 'the body is hashed as the exact bytes sent, not re-serialised',
    method: 'POST',
    path: '/terminals/T-1/capture',
    body: '{"amount":1250,"currency":"AUD"}',
  },
  {
    name: 'post-json-body-key-order-differs',
    catches: 'key order changes the hash — same object, different bytes',
    method: 'POST',
    path: '/terminals/T-1/capture',
    body: '{"currency":"AUD","amount":1250}',
  },
  {
    name: 'post-empty-body-string',
    catches: 'an empty body and no body hash identically',
    method: 'POST',
    path: '/terminals',
    body: '',
  },
  {
    name: 'post-unicode-body',
    catches: 'the body is hashed as UTF-8 bytes',
    method: 'POST',
    path: '/notes',
    body: '{"note":"café & co — 100% ✅"}',
  },
  {
    name: 'method-lowercase-input',
    catches: 'the method is uppercased before signing',
    method: 'delete',
    path: '/terminals/T-1',
  },
  {
    name: 'put-with-query-and-body',
    catches: 'all seven lines together, in order',
    method: 'PUT',
    path: '/terminals/T-1',
    query: { force: 'true' },
    body: '{"label":"front desk"}',
  },
];

const vectors = CASES.map((testCase) => {
  const { name, catches, method, path, query, body } = testCase;

  const canonicalRequest = buildCanonicalRequest({
    method,
    path,
    query,
    timestamp: TIMESTAMP,
    nonce: NONCE,
    body,
  });

  return {
    name,
    catches,
    request: {
      method,
      path,
      query: query ?? null,
      body: body ?? null,
    },
    timestamp: TIMESTAMP,
    nonce: NONCE,
    bodySha256: hashBody(body),
    canonicalRequest,
    signature: computeSignature(SECRET, canonicalRequest),
  };
});

const document = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  scheme: 'v1',
  algorithm: 'HMAC-SHA256',
  encoding: 'lowercase hex',
  description:
    'Conformance vectors for the v1 request signing scheme. Feed each request ' +
    'through your implementation with the given secret, timestamp and nonce; ' +
    'the canonical request and signature must match byte for byte.',
  canonicalRequestFormat: [
    'scheme version',
    'HTTP method, uppercase',
    'path, leading slash, each segment RFC 3986 encoded',
    'query, sorted by encoded key then encoded value',
    'timestamp, unix seconds',
    'nonce',
    'SHA-256 of the body, lowercase hex',
  ],
  separator: 'LF, no trailing newline',
  secret: SECRET,
  keyId: KEY_ID,
  headers: {
    'x-api-key': 'keyId',
    'x-timestamp': 'timestamp',
    'x-nonce': 'nonce',
    'x-signature': 'signature',
    'x-signature-version': 'v1',
  },
  vectors,
};

const target = fileURLToPath(new URL('../vectors/v1.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

process.stdout.write(`wrote ${vectors.length} vectors to vectors/v1.json\n`);
