/**
 * Webhook signature verification — the other direction.
 *
 * `verifyRequest` checks a request *this* side signed and sent. A webhook is
 * the reverse: the server signs and sends, and you verify what arrived. The
 * scheme is deliberately simpler — there is no path or query to canonicalise,
 * only a timestamp and the raw body — but it has one failure mode that the
 * request scheme does not, and it catches almost everyone.
 *
 * **The signature covers the bytes that arrived, not the object they parse
 * into.** Any framework that hands you `req.body` as a parsed object has
 * already destroyed the evidence: `JSON.parse` then `JSON.stringify` reorders
 * keys, drops insignificant whitespace, and re-encodes numbers, so the bytes
 * you hash are no longer the bytes that were signed. The result is a
 * verification that fails on perfectly legitimate deliveries, and the usual
 * response is to disable verification "temporarily".
 *
 * So `verifyWebhook` refuses a parsed object outright rather than quietly
 * re-serialising one. Getting the raw body is the caller's job — in Express
 * that means `express.raw({ type: 'application/json' })` on the webhook route.
 *
 * Header format, one line, Stripe-style:
 *
 *     t=1767225600,v1=<hex>,v1=<hex>
 *
 * Repeating `v1` is not a mistake. During a secret rotation the sender signs
 * with both the old and the new secret, so receivers on either side of the
 * rollout keep working; the verifier accepts if any candidate matches.
 */

import { createHmac } from 'node:crypto';

import { SignatureError } from './errors.js';
import { constantTimeEquals } from './signature.js';

export const WEBHOOK_SIGNATURE_VERSION = 'v1';
export const WEBHOOK_HEADER = 'x-webhook-signature';

/** Default replay window. Five minutes matches the request scheme. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The exact bytes that get HMAC'd: `<timestamp>.<raw body>`.
 *
 * Binding the timestamp into the signed payload is what makes the tolerance
 * check meaningful. If the timestamp travelled only in the header, an attacker
 * could replay a captured body with a fresh timestamp and it would still
 * verify — the signature would cover the body alone and say nothing about when
 * it was sent.
 */
export function buildWebhookPayload(timestamp, rawBody) {
  if (!Number.isInteger(timestamp)) {
    throw new SignatureError('timestamp must be an integer (unix seconds)');
  }

  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), toRawBytes(rawBody)]);
}

/**
 * Accept only what actually arrived on the wire.
 *
 * A plain object is rejected rather than serialised. Serialising it here would
 * produce a signature over bytes the sender never sent, which either fails
 * confusingly or — worse — succeeds by coincidence and trains the caller to
 * trust a check that is not doing anything.
 */
function toRawBytes(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  if (ArrayBuffer.isView(rawBody)) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);

  throw new SignatureError(
    'webhook body must be the raw string or Buffer that arrived, not a parsed object — ' +
      're-serialising it changes the bytes and the signature will not match ' +
      '(in Express, use express.raw({ type: "application/json" }) on this route)',
  );
}

/** HMAC-SHA256 over `<timestamp>.<raw body>`, hex encoded. */
export function computeWebhookSignature(secret, timestamp, rawBody) {
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) {
    throw new SignatureError('secret must be a string or Buffer');
  }
  if (secret.length === 0) throw new SignatureError('secret must not be empty');

  return createHmac('sha256', secret).update(buildWebhookPayload(timestamp, rawBody)).digest('hex');
}

/**
 * Produce a signature header. Mostly useful for testing a receiver, and for
 * anyone implementing the sending side.
 *
 * Pass several secrets to emit several `v1` entries — what a sender does mid
 * rotation.
 */
export function signWebhook({ secret, secrets, payload, timestamp = Math.floor(Date.now() / 1000) }) {
  const keys = secrets ?? (secret === undefined ? [] : [secret]);
  if (keys.length === 0) throw new SignatureError('signWebhook needs secret or secrets');

  const signatures = keys.map((key) => computeWebhookSignature(key, timestamp, payload));
  const header = [`t=${timestamp}`, ...signatures.map((s) => `${WEBHOOK_SIGNATURE_VERSION}=${s}`)].join(',');

  return { header, timestamp, signatures };
}

/**
 * Parse `t=...,v1=...,v1=...` into its parts.
 *
 * Unknown `vN=` schemes are collected rather than dropped, so a receiver can
 * report "this sender is using v2 and we only understand v1" instead of the
 * indistinguishable "no signature found".
 */
export function parseWebhookHeader(header) {
  if (typeof header !== 'string' || header.length === 0) {
    return { timestamp: null, signatures: [], unknownVersions: [] };
  }

  let timestamp = null;
  const signatures = [];
  const unknownVersions = [];

  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 1) continue;

    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();

    if (key === 't') {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) timestamp = parsed;
    } else if (key === WEBHOOK_SIGNATURE_VERSION) {
      signatures.push(value);
    } else if (/^v\d+$/.test(key)) {
      unknownVersions.push(key);
    }
  }

  return { timestamp, signatures, unknownVersions };
}

/**
 * Verify a delivered webhook.
 *
 * Returns `{ valid, reason }` rather than throwing — on a public endpoint an
 * invalid signature is an expected outcome, not an exception.
 *
 * @param {object} input
 * @param {string|Buffer|Array<string|Buffer>} [input.secret]  one secret
 * @param {Array<string|Buffer>}               [input.secrets] several, during rotation
 * @param {string}         input.header    the `x-webhook-signature` value
 * @param {string|Buffer}  input.payload   the RAW body, exactly as received
 * @param {number}        [input.toleranceMs]
 * @param {number}        [input.now]
 */
export function verifyWebhook({
  secret,
  secrets,
  header,
  payload,
  toleranceMs = DEFAULT_WEBHOOK_TOLERANCE_MS,
  now = Date.now(),
}) {
  const keys = secrets ?? (secret === undefined ? [] : [].concat(secret));
  if (keys.length === 0) throw new SignatureError('verifyWebhook needs secret or secrets');

  const { timestamp, signatures, unknownVersions } = parseWebhookHeader(header);

  if (timestamp === null) return fail('missing or malformed timestamp in signature header');
  if (signatures.length === 0) {
    return fail(
      unknownVersions.length > 0
        ? `no v1 signature — header carries only ${[...new Set(unknownVersions)].join(', ')}`
        : 'no v1 signature in header',
    );
  }

  const skew = Math.abs(now - timestamp * 1000);
  if (skew > toleranceMs) {
    return fail(`timestamp outside tolerance (skew ${Math.round(skew / 1000)}s)`);
  }

  // Compare every candidate against every secret without short-circuiting.
  // Bailing out on the first match would leak, through timing, which secret
  // and which position matched — and during a rotation that is precisely the
  // fact worth hiding.
  let matched = false;
  for (const key of keys) {
    const expected = computeWebhookSignature(key, timestamp, payload);
    for (const candidate of signatures) {
      if (constantTimeEquals(expected, candidate)) matched = true;
    }
  }

  if (!matched) return fail('signature mismatch');

  return { valid: true, reason: null, timestamp };
}

function fail(reason) {
  return { valid: false, reason };
}
