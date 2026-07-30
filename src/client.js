/**
 * The HTTP client itself.
 *
 * Built on the global `fetch` (Node 18+) so the package keeps a genuinely
 * empty dependency tree — no agent, no polyfill, no transitive supply chain.
 */

import { pool } from './bulk.js';
import { ApiError, ConfigError, NetworkError, TimeoutError } from './errors.js';
import {
  DEFAULT_RETRY_POLICY,
  computeDelay,
  isRetryableError,
  resolvePolicy,
  sleep,
} from './retry.js';
import { canonicalQuery, signRequest } from './signature.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export class TerminalClient {
  #baseUrl;
  #basePath;
  #keyId;
  #secret;
  #timeoutMs;
  #fetch;
  #defaultHeaders;
  #retry;
  #onRetry;
  #random;

  /**
   * @param {object}   options
   * @param {string}   options.baseUrl        e.g. `https://api.example.com` or `.../v2`
   * @param {string}   options.keyId          public key identifier, sent as `x-api-key`
   * @param {string}   options.secret         shared secret; never transmitted
   * @param {number}  [options.timeoutMs]     per-request timeout, default 10s
   * @param {Function}[options.fetch]         injectable for tests
   * @param {object}  [options.defaultHeaders]
   * @param {string}  [options.userAgent]
   * @param {object|false} [options.retry]  policy overrides, or false to disable
   * @param {Function}[options.onRetry]     called before each backoff
   * @param {Function}[options.random]      injectable for deterministic jitter
   */
  constructor(options = {}) {
    const { baseUrl, keyId, secret } = options;

    if (!baseUrl) throw new ConfigError('baseUrl is required');
    if (!keyId) throw new ConfigError('keyId is required');
    if (!secret) throw new ConfigError('secret is required');

    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch (cause) {
      throw new ConfigError(`baseUrl is not a valid URL: ${baseUrl}`, { cause });
    }

    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new ConfigError(
        `baseUrl must use https (got ${parsed.protocol}//) — an HMAC signature over a plaintext ` +
          'connection still exposes the request body',
      );
    }

    this.#baseUrl = parsed.origin;
    // A base URL may carry a path prefix (`/v2`). It is part of the signed
    // path, so capture it here rather than making every call site repeat it.
    this.#basePath = parsed.pathname.replace(/\/+$/, '');
    this.#keyId = keyId;
    this.#secret = secret;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#defaultHeaders = {
      'user-agent': options.userAgent ?? 'hmac-terminal-client/0.1.0',
      ...lowercaseKeys(options.defaultHeaders ?? {}),
    };

    this.#retry =
      options.retry === false
        ? { ...DEFAULT_RETRY_POLICY, retries: 0 }
        : { ...DEFAULT_RETRY_POLICY, ...(options.retry ?? {}) };
    this.#onRetry = options.onRetry ?? null;
    this.#random = options.random ?? Math.random;

    if (typeof this.#fetch !== 'function') {
      throw new ConfigError('global fetch is unavailable — use Node 18+ or pass options.fetch');
    }
  }

  /**
   * Send a signed request, retrying transient failures.
   *
   * Resolves to `{ status, headers, data }`. The verb helpers below unwrap
   * `data` for you; reach for `request` when you need the status or a
   * response header.
   *
   * Retries are on by default for idempotent methods only. Pass
   * `retry: true` to opt a POST or PATCH in, or `retry: false` to disable.
   */
  async request(method, path, options = {}) {
    const policy = resolvePolicy(this.#retry, options.retry, method);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#send(method, path, options);
      } catch (error) {
        // A caller who aborted wants out, not another attempt.
        if (options.signal?.aborted) throw error;
        if (attempt >= policy.retries || !isRetryableError(error)) throw error;

        const delayMs = computeDelay(attempt, policy, error.retryAfterMs ?? null, this.#random);
        this.#onRetry?.({ attempt: attempt + 1, delayMs, error, method, path });

        await sleep(delayMs, options.signal);
      }
    }
  }

  /**
   * One attempt: sign, send, map the response.
   *
   * Signing lives here rather than in `request` so every attempt is signed
   * afresh. Reusing the first signature would send a timestamp that is now
   * one backoff older and a nonce the server may already have recorded —
   * turning a retry of a 503 into a 401, which is a genuinely baffling thing
   * to debug.
   */
  async #send(method, path, { query, body, headers, signal, timeoutMs } = {}) {
    const signedPath = `${this.#basePath}${path.startsWith('/') ? path : `/${path}`}`;

    const signed = signRequest({
      keyId: this.#keyId,
      secret: this.#secret,
      method,
      path: signedPath,
      query,
      body,
    });

    // Send the *canonical* query string rather than re-serialising the object.
    // Any difference between what we sign and what we send is a 401 that is
    // miserable to debug, so there is only one serialisation.
    const search = canonicalQuery(query);
    const url = `${this.#baseUrl}${signedPath}${search ? `?${search}` : ''}`;

    const requestHeaders = {
      ...this.#defaultHeaders,
      ...lowercaseKeys(headers ?? {}),
      ...signed.headers,
      accept: 'application/json',
    };

    const payload = serialiseBody(body, requestHeaders);

    const effectiveTimeout = timeoutMs ?? this.#timeoutMs;
    const { signal: combined, cancel } = withTimeout(signal, effectiveTimeout);

    let response;
    try {
      response = await this.#fetch(url, {
        method: method.toUpperCase(),
        headers: requestHeaders,
        body: payload,
        signal: combined,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      if (cause?.name === 'AbortError' || cause?.name === 'TimeoutError') {
        throw new TimeoutError(effectiveTimeout, { cause });
      }
      throw new NetworkError(`${method.toUpperCase()} ${url} failed: ${cause.message}`, { cause });
    } finally {
      cancel();
    }

    const responseHeaders = headersToObject(response.headers);
    const data = await parseBody(response);

    if (!response.ok) {
      throw ApiError.from(response.status, {
        body: data,
        headers: responseHeaders,
        requestId: responseHeaders['x-request-id'] ?? null,
      });
    }

    return { status: response.status, headers: responseHeaders, data };
  }

  get(path, options) {
    return this.request('GET', path, options).then((r) => r.data);
  }

  post(path, body, options) {
    return this.request('POST', path, { ...options, body }).then((r) => r.data);
  }

  put(path, body, options) {
    return this.request('PUT', path, { ...options, body }).then((r) => r.data);
  }

  patch(path, body, options) {
    return this.request('PATCH', path, { ...options, body }).then((r) => r.data);
  }

  delete(path, options) {
    return this.request('DELETE', path, options).then((r) => r.data);
  }

  /**
   * Send many signed requests with bounded concurrency.
   *
   * Each entry is `{ method, path, ...callOptions }`. Resolves to one settled
   * result per request, in input order — see `pool` for the shape.
   *
   * Unlike the verb helpers these keep the full `{ status, headers, data }`.
   * Across a batch the per-item status is usually the thing you were after.
   *
   * @param {Array<object>} requests
   * @param {object} [options]  concurrency, stopOnError, signal
   */
  bulk(requests, options = {}) {
    return pool(
      requests,
      ({ method = 'GET', path, ...callOptions }) =>
        this.request(method, path, { signal: options.signal, ...callOptions }),
      options,
    );
  }
}

function serialiseBody(body, headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) return body;

  headers['content-type'] ??= 'application/json';
  return JSON.stringify(body);
}

async function parseBody(response) {
  const text = await response.text();
  if (text.length === 0) return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return text;

  try {
    return JSON.parse(text);
  } catch {
    // A body that claims to be JSON but isn't is the server's problem; hand
    // back the raw text so the caller can see what actually arrived.
    return text;
  }
}

function headersToObject(headers) {
  const out = {};
  for (const [key, value] of headers) out[key.toLowerCase()] = value;
  return out;
}

function lowercaseKeys(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key.toLowerCase(), value]));
}

/**
 * Combine a caller-supplied signal with a timeout.
 *
 * `AbortSignal.any` would do this in one line but landed in Node 20, and this
 * package supports 18.
 *
 * The timer is deliberately *not* unref'd. Unref'ing would let the process
 * exit while a request is still in flight, which is exactly the case the
 * timeout exists to bound — the deadline has to be a guarantee, not a hint.
 * `cancel()` runs in a `finally`, so the timer never outlives its request.
 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
