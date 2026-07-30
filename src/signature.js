/**
 * Canonical request construction and HMAC-SHA256 signing.
 *
 * The whole point of a canonical form is that the client and the server must
 * independently build a byte-identical string from the same request. Anywhere
 * the two implementations can disagree — query ordering, percent-encoding,
 * an empty body vs. a missing one — is a signature mismatch that surfaces as
 * an opaque 401. So every one of those cases is pinned down here explicitly,
 * and `verify()` lives in this same module so both directions stay in step.
 *
 * Canonical request (LF-separated, no trailing newline):
 *
 *     v1
 *     <METHOD>            uppercase
 *     <PATH>              leading slash, percent-encoded per segment
 *     <CANONICAL_QUERY>   sorted by key then value, RFC 3986 encoded
 *     <TIMESTAMP>         unix seconds
 *     <NONCE>             opaque, unique per request
 *     <BODY_SHA256>       lowercase hex; hash of "" when there is no body
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { SignatureError } from './errors.js';

export const SIGNATURE_VERSION = 'v1';

export const HEADER = Object.freeze({
  keyId: 'x-api-key',
  timestamp: 'x-timestamp',
  nonce: 'x-nonce',
  signature: 'x-signature',
  version: 'x-signature-version',
});

/** Default window either side of the server clock that a signature stays valid. */
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Percent-encode per RFC 3986.
 *
 * `encodeURIComponent` leaves `!'()*` untouched — legal for URIs, but it means
 * two implementations can produce different bytes for the same input. Encoding
 * them explicitly removes the ambiguity.
 */
export function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Serialise a query object into the canonical, order-independent form.
 *
 * Accepts a plain object, a `URLSearchParams`, or an array of pairs. Array
 * values expand into repeated keys. `undefined` and `null` values are dropped
 * entirely, so an absent parameter and one explicitly set to `undefined` sign
 * the same way — matching what actually goes on the wire.
 */
export function canonicalQuery(query) {
  if (!query) return '';

  const pairs = [];
  const push = (key, value) => {
    if (value === undefined || value === null) return;
    pairs.push([String(key), String(value)]);
  };

  if (query instanceof URLSearchParams) {
    for (const [key, value] of query) push(key, value);
  } else if (Array.isArray(query)) {
    for (const [key, value] of query) push(key, value);
  } else if (typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) push(key, item);
      } else {
        push(key, value);
      }
    }
  } else {
    throw new SignatureError('query must be an object, array of pairs, or URLSearchParams');
  }

  // Sort on the encoded bytes, not the raw string: the server sorts what it
  // receives off the wire, which is the encoded form.
  return pairs
    .map(([key, value]) => [rfc3986(key), rfc3986(value)])
    .sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Normalise a request path: always a leading slash, each segment encoded, and
 * any query string the caller accidentally baked in is rejected rather than
 * silently signed as part of the path.
 */
export function canonicalPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new SignatureError('path must be a non-empty string');
  }
  if (path.includes('?')) {
    throw new SignatureError('path must not contain a query string — pass `query` instead');
  }

  const withSlash = path.startsWith('/') ? path : `/${path}`;

  return withSlash
    .split('/')
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join('/');
}

/**
 * Hash a request body. Strings and buffers hash as-is; anything else is JSON
 * encoded first. Returns the hash of the empty string when there is no body,
 * so "no body" and "empty body" are indistinguishable — which is what the
 * server sees anyway.
 */
export function hashBody(body) {
  return createHash('sha256').update(bodyToBuffer(body)).digest('hex');
}

export function bodyToBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  try {
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch (cause) {
    throw new SignatureError('body could not be JSON-serialised', { cause });
  }
}

/**
 * Build the exact string that gets HMAC'd. Exported because it is the single
 * most useful thing to log when a server rejects a signature: diff this
 * against the server's canonical request and the mismatch is immediately
 * visible.
 */
export function buildCanonicalRequest({ method, path, query, timestamp, nonce, body }) {
  if (typeof method !== 'string' || method.length === 0) {
    throw new SignatureError('method must be a non-empty string');
  }
  if (!Number.isInteger(timestamp)) {
    throw new SignatureError('timestamp must be an integer (unix seconds)');
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new SignatureError('nonce must be a non-empty string');
  }

  return [
    SIGNATURE_VERSION,
    method.toUpperCase(),
    canonicalPath(path),
    canonicalQuery(query),
    String(timestamp),
    nonce,
    hashBody(body),
  ].join('\n');
}

/** HMAC-SHA256 a canonical request with the shared secret. */
export function computeSignature(secret, canonicalRequest) {
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) {
    throw new SignatureError('secret must be a string or Buffer');
  }
  if (secret.length === 0) {
    throw new SignatureError('secret must not be empty');
  }

  return createHmac('sha256', secret).update(canonicalRequest, 'utf8').digest('hex');
}

export function generateNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * Sign a request and produce the headers to send with it.
 *
 * `timestamp` and `nonce` are injectable so tests and cross-language
 * conformance vectors can pin them; in normal use they default to now and a
 * fresh 128-bit random value.
 */
export function signRequest({
  keyId,
  secret,
  method,
  path,
  query,
  body,
  timestamp = Math.floor(Date.now() / 1000),
  nonce = generateNonce(),
}) {
  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new SignatureError('keyId must be a non-empty string');
  }

  const canonicalRequest = buildCanonicalRequest({ method, path, query, timestamp, nonce, body });
  const signature = computeSignature(secret, canonicalRequest);

  return {
    canonicalRequest,
    signature,
    timestamp,
    nonce,
    headers: {
      [HEADER.keyId]: keyId,
      [HEADER.timestamp]: String(timestamp),
      [HEADER.nonce]: nonce,
      [HEADER.signature]: signature,
      [HEADER.version]: SIGNATURE_VERSION,
    },
  };
}

/**
 * Verify a signed request — the server side of the same scheme.
 *
 * Shipping this alongside the signer is what makes the self-test harness
 * possible: the suite can prove sign/verify symmetry locally instead of
 * discovering a mismatch against a live endpoint.
 *
 * Returns `{ valid, reason }` rather than throwing, because a failed
 * verification is an expected outcome on a public endpoint, not an exception.
 */
export function verifyRequest({
  secret,
  headers,
  method,
  path,
  query,
  body,
  toleranceMs = DEFAULT_TOLERANCE_MS,
  now = Date.now(),
}) {
  const get = (name) => {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
    const hit = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    return hit?.[1];
  };

  const version = get(HEADER.version);
  if (version !== SIGNATURE_VERSION) {
    return fail(`unsupported signature version: ${version ?? 'missing'}`);
  }

  const provided = get(HEADER.signature);
  const nonce = get(HEADER.nonce);
  const rawTimestamp = get(HEADER.timestamp);

  if (!provided) return fail('missing signature header');
  if (!nonce) return fail('missing nonce header');
  if (!rawTimestamp) return fail('missing timestamp header');

  const timestamp = Number(rawTimestamp);
  if (!Number.isInteger(timestamp)) return fail('timestamp is not an integer');

  const skew = Math.abs(now - timestamp * 1000);
  if (skew > toleranceMs) {
    return fail(`timestamp outside tolerance (skew ${Math.round(skew / 1000)}s)`);
  }

  let expected;
  try {
    expected = computeSignature(
      secret,
      buildCanonicalRequest({ method, path, query, timestamp, nonce, body }),
    );
  } catch (error) {
    return fail(`could not rebuild canonical request: ${error.message}`);
  }

  if (!constantTimeEquals(expected, provided)) return fail('signature mismatch');

  return { valid: true, reason: null, timestamp, nonce };
}

function fail(reason) {
  return { valid: false, reason };
}

/**
 * Compare two hex signatures without leaking their contents through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal, so the length check happens first and returns the same way
 * every other failure does.
 */
export function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}
