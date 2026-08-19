# hmac-terminal-client

**Zero-dependency Node client for HMAC-signed terminal APIs.**

![Node](https://img.shields.io/badge/node-%E2%89%A518.3-339933?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-16A34A)
![License](https://img.shields.io/badge/license-MIT-blue)

Signs requests with HMAC-SHA256 over a canonical request form, verifies them with
the same code path, and gives you a typed error for every way a call can fail.

Ships TypeScript declarations. No runtime dependencies, and no dev
dependencies either — tests run on the Node built-in test runner.
`npm install` fetches nothing.

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

Node 18.3 or newer — the client uses the global `fetch`, the CLI uses
`util.parseArgs`. Both are built in; the package still has no dependencies.

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
└── ApiError         non-2xx  (.status .code .body .requestId .retryAfterMs)
    ├── AuthError        401, 403
    └── RateLimitError   429
```

`Retry-After` is parsed on every status that sends it — not just 429, since
503 uses it too — from both legal forms, delta-seconds and HTTP-date, and
never comes back negative.

---

## Retries

On by default, and only where a replay is safe.

```js
const client = new TerminalClient({
  baseUrl, keyId, secret,
  retry: { retries: 2, minDelayMs: 200, maxDelayMs: 10_000, factor: 2 },
  onRetry: ({ attempt, delayMs, error }) => log.warn({ attempt, delayMs, status: error.status }),
});
```

**What gets retried:** `NetworkError`, `TimeoutError`, `429`, `408`, and `5xx`.
Nothing else. A 401 will still be a 401 in 200ms, and repeating a 400 just
burns rate limit.

**On which methods:** `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS` — the ones
where sending twice means the same as sending once.

`POST` and `PATCH` are **not** retried automatically. When a capture times out,
the request may well have reached the server and succeeded, with only the reply
lost; replaying it charges the customer twice. That is the caller's decision to
make, so it has to be stated:

```js
await client.post('/terminals/T-1/capture', { amount: 1250 }, { retry: true });
await client.get('/terminals', { retry: false });
```

Turning on [idempotency keys](#idempotency-keys) lifts that restriction
properly — see below.

**Backoff:** exponential with **full jitter** — uniformly random over
`[0, min(maxDelayMs, minDelayMs × factor^attempt)]`. Fixed backoff would
resynchronise every client that failed during the same outage, so they all
come back together and knock the service over again on the first retry.

A server `Retry-After` overrides the computed delay — it is the only party that
knows when capacity returns — but it is still capped at `maxDelayMs`, so a
misconfigured header cannot park the caller for an hour.

**Every attempt is signed afresh.** Reusing the first signature would send a
timestamp one backoff older and a nonce the server may already have recorded,
turning a retried 503 into a 401.

Aborting the caller's signal during a backoff releases immediately rather than
waiting out a timer nobody is interested in any more.

---

## Bulk operations

```js
const results = await client.bulk(
  terminalIds.map((id) => ({ method: 'POST', path: `/terminals/${id}/sync` })),
  { concurrency: 4 },
);

const { fulfilled, rejected, skipped } = partition(results);
```

Two things make this worth having over `Promise.all(items.map(send))`.

**The bound.** Mapping ten thousand items into `Promise.all` opens ten thousand
sockets, trips the rate limiter on the first hundred, and turns the rest into
retry pressure. A worker pool keeps a fixed number in flight and feeds from a
queue.

**Partial failure, which in a batch is the normal case.** `Promise.all` rejects
on the first error and discards every other result — including the successes.
For a batch of writes that is the worst possible outcome: you now know
something failed but not what already went through, so you cannot safely retry
any of it. `bulk` settles everything and returns one entry per input, **in
input order**:

```js
{ status: 'fulfilled', value }   // { status, headers, data }
{ status: 'rejected',  reason }  // the typed error
{ status: 'skipped' }            // never attempted
```

`skipped` is deliberately not `rejected`. After a batch of payments, "we never
sent this one" and "we sent it and it failed" call for completely different
follow-up.

`stopOnError: true` gives you fail-fast — and still hands back what it had:

```js
try {
  await client.bulk(requests, { stopOnError: true });
} catch (error) {
  error.index;    // where it stopped
  error.results;  // everything up to that point, including the successes
}
```

When several workers fail at once, the reported failure is the earliest by
*input position*, not whichever worker lost the race.

`pool(items, handler, options)` is exported for the general case — it has
nothing to do with HTTP and works over any async handler.

---

## CLI

```bash
npx terminal-api sign GET /terminals -q status=active
```

The `sign` and `canonical` subcommands are the reason this exists. When a
server rejects a signature there is nothing in the 401 to work with, and the
fastest way through is to print the exact string this end hashed and diff it
against the one the server built:

```bash
terminal-api canonical POST /terminals/T-1/capture -d '{"amount":1250}' \
  --timestamp 1767225600 --nonce ff00ff00ff00ff00ff00ff00ff00ff00
```

```
v1
POST
/terminals/T-1/capture
dryRun=true
1767225600
ff00ff00ff00ff00ff00ff00ff00ff00
9fb40105c56271ac9d6a8da0a6f584dd901d66e4d55081684160a5bc608c7b08
```

Pinning `--timestamp` and `--nonce` makes the output byte-for-byte
reproducible, so the diff shows only what genuinely differs.

| Command | |
| :--- | :--- |
| `request <METHOD> <PATH>` | sign and send |
| `sign <METHOD> <PATH>` | print the signature headers without sending |
| `canonical <METHOD> <PATH>` | print only the canonical request |
| `verify <METHOD> <PATH>` | check supplied `-H` headers against a signature |

`verify` prints its own canonical request on failure — again, so there is
something to diff rather than just a verdict.

**Exit codes** are distinct so scripts can branch on them: `0` success,
`1` API error, `2` usage error, `3` network or timeout, `4` signature invalid.

**Credentials** come from `TERMINAL_BASE_URL`, `TERMINAL_KEY_ID` and
`TERMINAL_SECRET`. `--secret` works but warns: argv is readable by any process
that can run `ps`, and it lands in shell history.

> On Git Bash for Windows, MSYS rewrites `/terminals` into a Windows path
> before the CLI ever sees it. Prefix with `MSYS_NO_PATHCONV=1`.

---

## Webhooks

The other direction: the server signs, you verify what arrived.

```js
import { verifyWebhook } from 'hmac-terminal-client';

app.post('/hooks', express.raw({ type: 'application/json' }), (req, res) => {
  const { valid, reason } = verifyWebhook({
    secret: process.env.WEBHOOK_SECRET,
    header: req.get('x-webhook-signature'),
    payload: req.body,          // the raw Buffer — not a parsed object
  });

  if (!valid) return res.status(401).json({ error: reason });

  const event = JSON.parse(req.body);   // parse only after verifying
  res.sendStatus(200);
});
```

### The raw body is the whole game

The signature covers **the bytes that arrived**, not the object they parse
into. Any framework handing you `req.body` as a parsed object has already
destroyed the evidence — `JSON.parse` then `JSON.stringify` reorders keys,
drops whitespace and re-encodes numbers, so the bytes you hash are no longer
the bytes that were signed.

The result is verification failing on perfectly legitimate deliveries, and the
usual response to that is to turn verification off "temporarily".

So `verifyWebhook` **refuses a parsed object** rather than quietly
re-serialising one, and the error tells you how to fix it:

```
webhook body must be the raw string or Buffer that arrived, not a parsed
object — re-serialising it changes the bytes and the signature will not match
(in Express, use express.raw({ type: "application/json" }) on this route)
```

The suite proves the point: `{"event":"x","amount":1}` and
`{"amount":1,"event":"x"}` parse identically and one of them must fail.

### Secret rotation

The header carries a timestamp and one or more signatures:

```
t=1767225600,v1=<hex>,v1=<hex>
```

Repeating `v1` is not a mistake. Mid-rotation the sender signs with the old
secret and the new one, so receivers on either side of the rollout keep
working. `verifyWebhook` accepts a single secret or an array, and matches
against every candidate.

Comparison never short-circuits on the first match — bailing early would leak,
through timing, *which* secret matched, and during a rotation that is exactly
the fact worth hiding.

### Replay

The timestamp is inside the signed payload, not just the header. Editing it to
look fresh invalidates the signature rather than extending its life. Deliveries
outside a five-minute window (configurable, enforced in both directions) are
rejected.

An unrecognised scheme is reported as such — `no v1 signature — header carries
only v2` rather than the indistinguishable "no signature found".

---

## Observability, without leaking the thing you are protecting

The obvious way to debug a signing problem is to log the request. The obvious
way to log a request is `console.log(headers)` — which prints `x-signature` in
full, and one copy-paste later the secret is in a log aggregator, indexed,
replicated, retained. Nobody decides to do that; it happens while chasing a 401
at eleven at night.

So the hooks hand over an **already-redacted** view. Redaction is not a flag to
remember — it is what the argument is:

```js
const client = new TerminalClient({
  baseUrl, keyId, secret,
  onRequest:  (e) => log.debug('→', e.method, e.url, { attempt: e.attempt, key: e.idempotencyKey }),
  onResponse: (e) => log.debug('←', e.status, `${e.durationMs}ms`, { requestId: e.requestId }),
});
```

| field | treatment | why |
| :--- | :--- | :--- |
| `x-signature` | `aaaaaaaa…(64)` | enough to compare two attempts, not enough to replay |
| `authorization`, `cookie` | `[redacted]` | no useful prefix exists |
| `x-api-key` | **kept** | a public identifier — hiding it makes logs useless |
| `x-nonce` | **kept** | per-request and worthless to an attacker; the fastest way to confirm each attempt re-signed |
| `idempotency-key` | **kept** | not a credential, and the single most useful field when tracing a retried write |
| query `?token=`, `?secret=` | `[redacted]` | the other place credentials end up |

**The body is not included at all.** It is the largest thing in the request and
the most likely to hold card numbers, names and addresses — logging it by
default would trade one leak for a worse one. Anyone who needs it has it at the
call site already.

Attempts are numbered, so a retried write is legible as one logical request
rather than three unrelated ones. The response hook fires on error statuses too,
but not when the request never arrived — a `NetworkError` produces a request
event and no response event, which is exactly the shape of the failure.

`redactHeaders` returns a new object and never mutates its input. A redactor
that edited the outgoing headers would break the signature it was helping you
debug; there is a test for that.

---

## Conformance vectors

A signing scheme is only useful if two independent implementations agree, and
"read the README carefully" is not a mechanism. `vectors/v1.json` is one:

```json
{
  "name": "query-rfc3986-characters",
  "catches": "encodeURIComponent leaves !'()* raw — RFC 3986 does not",
  "request": { "method": "GET", "path": "/search", "query": { "q": "!'()*" } },
  "timestamp": 1767225600,
  "nonce": "ff00ff00ff00ff00ff00ff00ff00ff00",
  "canonicalRequest": "v1
GET
/search
q=%21%27%28%29%2A
...",
  "signature": "..."
}
```

A server team writing the Python or Go half loads the file, feeds each request
through their own code with the given secret, timestamp and nonce, and compares.
No live endpoint, no arguing about which side is wrong.

Sixteen cases, each named for the disagreement it exists to catch — a vector
for the happy path proves almost nothing, while one for `!'()*` proves whether
somebody reached for `encodeURIComponent`. Every one carries a `catches` field
saying what a mismatch probably means, which is more use than a bad hash.

Covered: query sorting by key and by value · RFC 3986 vs `encodeURIComponent` ·
`%20` vs `+` · reserved characters in keys and values · empty value vs absent ·
unicode in query and body · path segment encoding · base path prefixes · method
casing · empty body vs no body · **JSON key order changing the hash**.

The suite reads the committed file and checks the implementation reproduces it
— never the reverse, which would be circular and pass regardless. So a change
to the canonical form fails loudly, with a diff of the exact string that moved.

```bash
npm run vectors   # regenerate
```

Regenerating is a deliberate act. If the committed file changes, the wire format
changed and every existing integration breaks — the diff is the warning, and it
is meant to be read rather than waved through.

---

## Idempotency keys

The retry policy refuses to replay a `POST`, because a request that timed out
may already have succeeded. That is the right default, but it is a *refusal*,
not a solution: the write still needs to happen and the caller is left to work
out whether it already did.

```js
const client = new TerminalClient({ baseUrl, keyId, secret, idempotency: true });

await client.post('/terminals/T-1/capture', { amount: 1250 });
// sends idempotency-key: 7c9e6679-...  and retries on 5xx, safely
```

The client sends a key with the write; the server records it against the
outcome; a second request with the same key returns the first result instead of
doing the work again. Replay stops being dangerous, so the retry can just
happen — `POST` and `PATCH` become retryable the moment a key is attached.

**The key is minted once per logical request and reused by every attempt.** This
is the entire mechanism, and the easy way to get it wrong is to generate one
per attempt — which looks like protection, costs a header, still double-charges,
and convinces everyone the problem is handled. A test asserts one key across
three attempts.

The signature is the opposite: **fresh on every attempt**, because a replayed
signature carries a stale timestamp and a used nonce. Stable key, fresh
signature — confusing the two breaks one or the other, so both are pinned.

Supply your own when the dedup boundary is outside this process:

```js
await client.post('/payouts', batch, { idempotencyKey: `payout-${job.id}` });
```

An explicit key wins over the policy, including on a method it would otherwise
skip — a caller passing one has a reason.

> **The key is not covered by the signature.** The scheme signs method, path,
> query, timestamp, nonce and body, not arbitrary headers, so the key travels
> as an unsigned dedup hint. Replay protection comes from the nonce and
> timestamp, which *are* signed; the key deduplicates deliberate retries. A
> test asserts it is absent from the canonical request rather than leaving that
> to be inferred.

---

## Pagination

```js
for await (const terminal of client.paginateItems('/terminals', { query: { limit: 100 } })) {
  await sync(terminal);
}
```

The obvious version of this is a `while (cursor)` loop that accumulates every
page into an array. It has two problems, and the second is why this module
exists.

**It holds everything in memory.** Listing 200,000 terminals to act on each one
costs 200,000 objects of heap for no reason. `for await` hands them over a page
at a time, and `break` stops the requests — a test asserts that breaking on the
second page issues exactly two.

**It trusts the server to say stop.** A misconfigured endpoint that echoes back
the cursor it was given — or a `next` link pointing at the current page — turns
that loop into an unkillable request flood against the API you were trying to
be polite to. Nobody writes a guard for that until it has happened once:

```
PaginationError: Pagination looped: cursor abc123 was already followed after 2 pages
```

Every cursor is remembered, so a three-step cycle is caught as readily as an
immediate repeat.

`maxPages` is a second valve, and when it trips it **throws** rather than
returning what it had. Silent truncation looks exactly like a complete result
set, which is the worst way for this to fail. To stop early on purpose, `break`.

Cursor extraction reads the payload, not the `{ status, headers, data }`
wrapper — a default that searched the wrapper would find nothing and every walk
would quietly end after one page. The default understands `next_cursor`,
`nextCursor`, `next` and `cursor`; anything else gets an explicit `cursorFrom`:

```js
client.paginate('/terminals', {
  cursorParam: 'page_token',
  cursorFrom: (data) => data.pagination.next,
  maxPages: 500,
});
```

Every page is a fresh signed request. A walk over hundreds of pages outlives
any single signature's tolerance window, so reusing one would start failing
partway through.

`paginate(fetchPage, options)` is exported for the general case — it has
nothing to do with HTTP.

---

## TypeScript

Types ship with the package — `src/index.d.ts`, no `@types` install, no build
step.

```ts
import { TerminalClient, type TerminalResponse, type SettledResult } from 'hmac-terminal-client';

const client = new TerminalClient({ baseUrl, keyId, secret });

const terminals = await client.get<Terminal[]>('/terminals');
const { status, data } = await client.request<Terminal>('GET', '/terminals/T-1');
```

The declarations are **hand-written**. Adding TypeScript purely to emit them
would put the first entry in a `devDependencies` block that is empty on
purpose, and the package installing nothing is worth more than a build step.

The obvious objection to hand-written types is that they drift — a new export
ships and nobody updates the declarations, or a rename leaves one pointing at
something that no longer exists. So the suite checks it, without TypeScript:
it compares the runtime export list against the declarations in both
directions, and asserts the declared `extends` chain matches the real
prototype chain, since that is what consumers narrow on.

What it does **not** check is shapes — nothing would catch a parameter typed
`string` that should be `number`. It catches the whole category of missing and
stale declarations, which is the one that actually bites.

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
| `retry` | see [Retries](#retries) | `false` disables |
| `onRetry` | — | `({ attempt, delayMs, error, method, path }) => void` |
| `random` | `Math.random` | Injectable for deterministic jitter |

Methods: `request(method, path, options)` · `get` · `post` · `put` · `patch` ·
`delete` · `bulk(requests, options)`. Per-call options: `query`, `body`,
`headers`, `signal`, `timeoutMs`, `retry`.

Signing primitives, all exported: `signRequest` · `verifyRequest` ·
`buildCanonicalRequest` · `canonicalQuery` · `canonicalPath` · `hashBody` ·
`computeSignature` · `constantTimeEquals` · `generateNonce` · `rfc3986`.

Retry primitives, also exported so you can reuse the policy elsewhere:
`isRetryableError` · `computeDelay` · `resolvePolicy` · `sleep` ·
`DEFAULT_RETRY_POLICY` · `IDEMPOTENT_METHODS`.

Bulk primitives: `pool` · `partition` · `BulkError` · `DEFAULT_CONCURRENCY`.

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
npm test        # 388 tests, node:test, no install required
npm run coverage
```

There is no install step and nothing to build — `node --test` is the whole
toolchain. The suite passes on Node 18, 20 and 22.

---

## License

MIT
