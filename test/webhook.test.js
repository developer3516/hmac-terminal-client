import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  SignatureError,
  buildWebhookPayload,
  computeWebhookSignature,
  parseWebhookHeader,
  signWebhook,
  verifyWebhook,
} from '../src/index.js';

const SECRET = 'whsec_live_0123456789abcdef';
const OLD_SECRET = 'whsec_live_rotated_out';
const TIMESTAMP = 1_767_225_600;
const NOW = TIMESTAMP * 1000;
const PAYLOAD = '{"event":"capture.succeeded","amount":1250}';

describe('buildWebhookPayload', () => {
  it('joins the timestamp and body with a dot', () => {
    assert.equal(buildWebhookPayload(TIMESTAMP, 'body').toString('utf8'), `${TIMESTAMP}.body`);
  });

  it('treats a Buffer body identically to the same bytes as a string', () => {
    assert.deepEqual(
      buildWebhookPayload(TIMESTAMP, Buffer.from(PAYLOAD)),
      buildWebhookPayload(TIMESTAMP, PAYLOAD),
    );
  });

  it('preserves bytes a JSON round trip would not', () => {
    // Whitespace and key order survive because the body is never parsed.
    const spaced = '{ "b": 2, "a": 1 }';
    assert.equal(buildWebhookPayload(TIMESTAMP, spaced).toString('utf8').endsWith(spaced), true);
  });

  it('rejects a non-integer timestamp', () => {
    assert.throws(() => buildWebhookPayload(1.5, 'body'), /integer/);
  });
});

describe('raw body enforcement', () => {
  it('refuses a parsed object rather than re-serialising it', () => {
    // The single most common webhook bug: `JSON.parse` then `JSON.stringify`
    // reorders keys and drops whitespace, so the bytes no longer match.
    assert.throws(
      () => computeWebhookSignature(SECRET, TIMESTAMP, { event: 'capture.succeeded' }),
      SignatureError,
    );
  });

  it('explains how to get the raw body instead of just refusing', () => {
    assert.throws(() => buildWebhookPayload(TIMESTAMP, { a: 1 }), /express\.raw/);
  });

  it('accepts a string, a Buffer and a typed array', () => {
    const expected = computeWebhookSignature(SECRET, TIMESTAMP, PAYLOAD);

    assert.equal(computeWebhookSignature(SECRET, TIMESTAMP, Buffer.from(PAYLOAD)), expected);
    assert.equal(
      computeWebhookSignature(SECRET, TIMESTAMP, new Uint8Array(Buffer.from(PAYLOAD))),
      expected,
    );
  });

  it('rejects an empty secret rather than signing with one', () => {
    assert.throws(() => computeWebhookSignature('', TIMESTAMP, PAYLOAD), /must not be empty/);
  });
});

describe('parseWebhookHeader', () => {
  it('parses a timestamp and one signature', () => {
    const parsed = parseWebhookHeader('t=1767225600,v1=abc');

    assert.equal(parsed.timestamp, TIMESTAMP);
    assert.deepEqual(parsed.signatures, ['abc']);
  });

  it('collects repeated v1 entries in order', () => {
    assert.deepEqual(parseWebhookHeader('t=1,v1=a,v1=b,v1=c').signatures, ['a', 'b', 'c']);
  });

  it('tolerates whitespace around the parts', () => {
    const parsed = parseWebhookHeader('t=1767225600 , v1=abc');

    assert.equal(parsed.timestamp, TIMESTAMP);
    assert.deepEqual(parsed.signatures, ['abc']);
  });

  it('records unknown schemes instead of dropping them', () => {
    // So a receiver can say "you are sending v2 and we speak v1" rather than
    // the indistinguishable "no signature found".
    const parsed = parseWebhookHeader('t=1,v2=abc,v3=def');

    assert.deepEqual(parsed.signatures, []);
    assert.deepEqual(parsed.unknownVersions, ['v2', 'v3']);
  });

  it('returns empties for a missing or malformed header', () => {
    for (const header of [undefined, null, '', 'garbage', 't=notanumber']) {
      const parsed = parseWebhookHeader(header);
      assert.equal(parsed.timestamp, null);
      assert.deepEqual(parsed.signatures, []);
    }
  });
});

describe('signWebhook', () => {
  it('emits a header the parser round-trips', () => {
    const { header } = signWebhook({ secret: SECRET, payload: PAYLOAD, timestamp: TIMESTAMP });

    assert.match(header, /^t=1767225600,v1=[0-9a-f]{64}$/);
    assert.equal(parseWebhookHeader(header).timestamp, TIMESTAMP);
  });

  it('emits one v1 entry per secret during a rotation', () => {
    const { header, signatures } = signWebhook({
      secrets: [OLD_SECRET, SECRET],
      payload: PAYLOAD,
      timestamp: TIMESTAMP,
    });

    assert.equal(signatures.length, 2);
    assert.equal(header.match(/v1=/g).length, 2);
  });

  it('defaults the timestamp to now', () => {
    const { timestamp } = signWebhook({ secret: SECRET, payload: PAYLOAD });

    assert.ok(Math.abs(timestamp - Math.floor(Date.now() / 1000)) <= 1);
  });

  it('requires a secret', () => {
    assert.throws(() => signWebhook({ payload: PAYLOAD }), /needs secret or secrets/);
  });
});

describe('verifyWebhook', () => {
  const signed = signWebhook({ secret: SECRET, payload: PAYLOAD, timestamp: TIMESTAMP });

  const verify = (overrides = {}) =>
    verifyWebhook({ secret: SECRET, header: signed.header, payload: PAYLOAD, now: NOW, ...overrides });

  it('accepts a genuine delivery', () => {
    assert.deepEqual(verify(), { valid: true, reason: null, timestamp: TIMESTAMP });
  });

  it('accepts the raw body as a Buffer', () => {
    assert.equal(verify({ payload: Buffer.from(PAYLOAD) }).valid, true);
  });

  it('rejects a tampered body', () => {
    const tampered = PAYLOAD.replace('1250', '999999');

    assert.equal(verify({ payload: tampered }).reason, 'signature mismatch');
  });

  it('rejects a body whose bytes changed but whose meaning did not', () => {
    // Same two keys, same two values, opposite order — `JSON.parse` gives an
    // identical object, and the signature still has to fail. This is exactly
    // what a receiver does to itself by re-serialising, and why the raw body
    // is demanded instead.
    const reordered = '{"amount":1250,"event":"capture.succeeded"}';

    assert.deepEqual(JSON.parse(reordered), JSON.parse(PAYLOAD));
    assert.notEqual(reordered, PAYLOAD);
    assert.equal(verify({ payload: reordered }).valid, false);
  });

  it('rejects the wrong secret', () => {
    assert.equal(verify({ secret: 'whsec_wrong' }).reason, 'signature mismatch');
  });

  it('rejects a stale delivery outside the tolerance', () => {
    assert.match(verify({ now: NOW + 3_600_000 }).reason, /outside tolerance/);
  });

  it('rejects a timestamp too far ahead, not only behind', () => {
    assert.match(verify({ now: NOW - 3_600_000 }).reason, /outside tolerance/);
  });

  it('accepts a delivery at the edge of the window', () => {
    assert.equal(verify({ now: NOW + DEFAULT_WEBHOOK_TOLERANCE_MS }).valid, true);
  });

  it('rejects a replay of an old body under a fresh timestamp', () => {
    // The timestamp is inside the signed payload, so swapping it in the header
    // invalidates the signature rather than extending its life.
    const replayed = signed.header.replace(`t=${TIMESTAMP}`, `t=${TIMESTAMP + 600}`);

    assert.equal(verifyWebhook({
      secret: SECRET,
      header: replayed,
      payload: PAYLOAD,
      now: (TIMESTAMP + 600) * 1000,
    }).reason, 'signature mismatch');
  });

  it('names a missing timestamp and a missing signature separately', () => {
    assert.match(verify({ header: 'v1=abc' }).reason, /missing or malformed timestamp/);
    assert.match(verify({ header: 't=1767225600' }).reason, /no v1 signature/);
  });

  it('says which scheme the sender used when it is not v1', () => {
    assert.match(verify({ header: 't=1767225600,v2=abc' }).reason, /carries only v2/);
  });

  it('requires a secret', () => {
    assert.throws(() => verifyWebhook({ header: signed.header, payload: PAYLOAD }), /needs secret or secrets/);
  });

  describe('secret rotation', () => {
    const dual = signWebhook({ secrets: [OLD_SECRET, SECRET], payload: PAYLOAD, timestamp: TIMESTAMP });

    it('accepts a dual-signed delivery on either side of the rollout', () => {
      for (const key of [OLD_SECRET, SECRET]) {
        assert.equal(
          verifyWebhook({ secret: key, header: dual.header, payload: PAYLOAD, now: NOW }).valid,
          true,
          `receiver holding ${key}`,
        );
      }
    });

    it('accepts a receiver that holds both secrets', () => {
      assert.equal(verify({ secrets: [OLD_SECRET, SECRET] }).valid, true);
    });

    it('still rejects a delivery signed with neither', () => {
      const foreign = signWebhook({ secret: 'whsec_attacker', payload: PAYLOAD, timestamp: TIMESTAMP });

      assert.equal(
        verifyWebhook({ secrets: [OLD_SECRET, SECRET], header: foreign.header, payload: PAYLOAD, now: NOW }).valid,
        false,
      );
    });

    it('accepts a single secret passed as an array', () => {
      assert.equal(verify({ secret: [SECRET] }).valid, true);
    });
  });
});

describe('end-to-end over HTTP', () => {
  let server;
  let port;
  const received = [];

  before(async () => {
    server = createServer((req, res) => {
      // Collect the body as bytes. Never `JSON.parse` before verifying — that
      // is the whole point.
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const result = verifyWebhook({
          secret: SECRET,
          header: req.headers['x-webhook-signature'],
          payload: raw,
        });

        received.push({ valid: result.valid, reason: result.reason });
        res.statusCode = result.valid ? 200 : 401;
        res.end(JSON.stringify(result));
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  async function deliver(body, header) {
    const response = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': header },
      body,
    });
    return response.status;
  }

  it('accepts a delivery signed moments earlier', async () => {
    const body = JSON.stringify({ event: 'capture.succeeded', amount: 1250 });
    const { header } = signWebhook({ secret: SECRET, payload: body });

    assert.equal(await deliver(body, header), 200);
  });

  it('rejects a body modified in flight', async () => {
    const body = JSON.stringify({ event: 'capture.succeeded', amount: 1250 });
    const { header } = signWebhook({ secret: SECRET, payload: body });

    assert.equal(await deliver(body.replace('1250', '999999'), header), 401);
  });

  it('survives a body a JSON round trip would have altered', async () => {
    // Trailing spaces and non-alphabetical key order: signed and delivered
    // byte-for-byte, so it verifies. A receiver that re-serialised would
    // reject this legitimate delivery.
    const body = '{ "z": 1,  "a": 2 }';
    const { header } = signWebhook({ secret: SECRET, payload: body });

    assert.equal(await deliver(body, header), 200);
    assert.equal(received.at(-1).valid, true);
  });
});
