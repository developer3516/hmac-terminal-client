# hmac-terminal-client

**Zero-dependency Node client for HMAC-signed terminal APIs.**

![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-16A34A)
![License](https://img.shields.io/badge/license-MIT-blue)

Signs requests with HMAC-SHA256 over a canonical request form, verifies them with
the same code path, and gives you a typed error for every way a call can fail.

No runtime dependencies. No dev dependencies either — tests run on the Node
built-in test runner. `npm install` fetches nothing.

---

## Why this exists

HMAC request signing is simple in principle and miserable in practice. The
client and the server each build a string from the request and hash it, and the
signature only matches if both produce *byte-identical* input. Every place the
two can quietly disagree becomes an opaque `401`:

| Disagreement | What actually happens |
| :--- | :--- |
| Query parameter ordering | `?a=1&b=2` signs differently from `?b=2&a=1` |
| `encodeURIComponent` vs. RFC 3986 | `!'()*` are left raw by one side, encoded by the other |
| Empty body vs. no body | One hashes `""`, the other skips the field |
| Re-serialising the query for the URL | You sign one string and send another |
| Clock skew | A valid signature rejected for being 40 seconds old |

This client pins down each of those cases explicitly, and ships `verifyRequest`
— the server half of the scheme — in the same module. That is what makes the
signing testable: the suite proves sign/verify symmetry locally instead of
finding out against a live endpoint.

---

## Install

```bash
npm install hmac-terminal-client
```

Node 18 or newer (the client uses the global `fetch`).

---

## Usage

```js
import { TerminalClient } from 'hmac-terminal-client';

const client = new TerminalClient({
  baseUrl: 'https://api.example.com/v2',
  keyId: process.env.TERMINAL_KEY_ID,
  secret: process.env.TERMINAL_SECRET,
  timeoutMs: 10_000,
});

const terminals = await client.get('/terminals', { query: { status: 'active', limit: 10 } });

const capture = await client.post('/terminals/T-1/capture', {
  amount: 1250,
  currency: 'AUD',
});
```

The verb helpers return the parsed body. When you need the status or a response
header, use `request` directly:

```js
const { status, headers, data } = await client.request('POST', '/terminals', { body: {} });
console.log(headers['x-request-id']);
```

### Handling failures

Every error extends `TerminalError`, so you can tell "the request never left"
apart from "the server said no" without matching on message strings.

```js
import { AuthError, RateLimitError, TimeoutError, NetworkError } from 'hmac-terminal-client';

try {
  await client.post('/terminals/T-1/capture', { amount: 1250 });
} catch (error) {
  if (error instanceof RateLimitError) await sleep(error.retryAfterMs ?? 1000);
  else if (error instanceof AuthError) throw new Error('check the API key and clock skew');
  else if (error instanceof TimeoutError || error instanceof NetworkError) enqueueForRetry();
  else throw error;
}
```

```
TerminalError
├── ConfigError      client constructed wrong — a caller bug
├── SignatureError   the signing input was malformed
├── NetworkError     DNS / TCP / TLS / dropped socket
├── TimeoutError     aborted locally after `timeoutMs`
└── ApiError         non-2xx response  (.status .code .body .requestId)
    ├── AuthError        401, 403
    └── RateLimitError   429  (.retryAfterMs, parsed from Retry-After)
```

`Retry-After` is parsed from both legal forms — delta-seconds and HTTP-date —
and never comes back negative.

---

## The signing scheme

The canonical request is seven LF-separated lines, with no trailing newline:

```
v1
POST
/v2/terminals/T-1/capture
dryRun=true
1767225600
ff00ff00ff00ff00ff00ff00ff00ff00
8f4e1b...  ← SHA-256 of the body, lowercase hex
```

| Line | Rule |
| :--- | :--- |
| 1 | Scheme version, currently `v1` |
| 2 | HTTP method, uppercase |
| 3 | Path with a leading slash, each segment RFC 3986 encoded |
| 4 | Query sorted by encoded key then encoded value; `undefined`/`null` dropped |
| 5 | Unix seconds |
| 6 | Per-request nonce (128 bits of hex by default) |
| 7 | SHA-256 of the body, lowercase hex; hash of `""` when there is no body |

`signature = HMAC-SHA256(secret, canonicalRequest)`, hex encoded, sent as:

```
x-api-key:            <keyId>
x-timestamp:          <unix seconds>
x-nonce:              <nonce>
x-signature:          <hex>
x-signature-version:  v1
```

The client sends the *canonical* query string on the wire rather than
re-serialising the object, so there is exactly one serialisation and no way for
the signed and sent forms to drift apart.

### Verifying on the server

```js
import { verifyRequest } from 'hmac-terminal-client';

const { valid, reason, nonce } = verifyRequest({
  secret: lookupSecret(req.get('x-api-key')),
  headers: req.headers,
  method: req.method,
  path: req.path,
  query: req.query,
  body: req.body,
});

if (!valid) return res.status(401).json({ error: reason });
```

`verifyRequest` returns `{ valid, reason }` instead of throwing — on a public
endpoint a bad signature is an expected outcome, not an exception. It checks
the version, the presence of each header, clock skew against a configurable
tolerance (5 minutes by default, in both directions), and finally compares
signatures with `crypto.timingSafeEqual`.

> **Replay protection is your job.** The scheme carries a nonce and a
> timestamp, but this library does not store seen nonces — persist them for at
> least the tolerance window if you need replay resistance.

### Debugging a signature mismatch

`buildCanonicalRequest` is exported for exactly this. Log it on both sides and
diff — the mismatched line is immediately visible.

```js
import { buildCanonicalRequest } from 'hmac-terminal-client';

console.log(JSON.stringify(buildCanonicalRequest({
  method: 'POST', path: '/v2/terminals', query: { a: 1 },
  timestamp: 1767225600, nonce: 'ff00…', body: { amount: 1250 },
})));
```

---

## API

**`new TerminalClient(options)`**

| Option | Default | Notes |
| :--- | :--- | :--- |
| `baseUrl` | — | Required. Must be `https`, except on `localhost` / `127.0.0.1` |
| `keyId` | — | Required. Sent as `x-api-key` |
| `secret` | — | Required. Never transmitted |
| `timeoutMs` | `10000` | Per-request; overridable per call |
| `fetch` | `globalThis.fetch` | Injectable for tests |
| `defaultHeaders` | `{}` | Merged into every request |
| `userAgent` | `hmac-terminal-client/<version>` | |

Methods: `request(method, path, options)` · `get` · `post` · `put` · `patch` ·
`delete`. Per-call options: `query`, `body`, `headers`, `signal`, `timeoutMs`.

Signing primitives, all exported: `signRequest` · `verifyRequest` ·
`buildCanonicalRequest` · `canonicalQuery` · `canonicalPath` · `hashBody` ·
`computeSignature` · `constantTimeEquals` · `generateNonce` · `rfc3986`.

---

## Design notes

**`baseUrl` must be https.** An HMAC signature authenticates a request; it does
not encrypt it. Over plaintext the body is still readable, so the constructor
refuses rather than letting a misconfiguration ship. `localhost` is exempted
for development.

**Signed headers cannot be overridden.** Per-call `headers` are merged *before*
the signature headers, so a caller cannot accidentally — or deliberately —
replace `x-signature`.

**The timeout timer is not `unref`'d.** Unref'ing would let the process exit
while a request is in flight, which is the exact case the timeout exists to
bound. `cancel()` runs in a `finally`, so the timer never outlives its request.

**Length mismatches short-circuit before `timingSafeEqual`.** That function
throws on unequal lengths, and a thrown error is itself a timing signal, so the
length check happens first and fails the same way every other check does.

---

## Tests

```bash
npm test        # 81 tests, node:test, no install required
npm run coverage
```

There is no install step and nothing to build — `node --test` is the whole
toolchain. The suite passes on Node 18, 20 and 22.

---

## License

MIT
