/**
 * Redaction, and the observability hooks that use it.
 *
 * The obvious way to debug a signing problem is to log the request. The
 * obvious way to log a request is `console.log(headers)`. That prints
 * `x-signature` in full, and one copy-paste later the secret itself is in a
 * log aggregator, indexed, replicated, and retained for however long the
 * retention policy says. Nobody decides to do this; it happens while chasing a
 * 401 at eleven at night.
 *
 * So the hooks here hand over an already-redacted view. Redaction is not a
 * flag to remember — it is what the argument *is*. Getting the unredacted
 * value requires reaching past the hook to the code that produced it, which is
 * a deliberate act rather than a default.
 *
 * What gets hidden, and what deliberately does not:
 *
 *   `x-signature`      truncated — enough to compare two logs, not enough to
 *                      replay, and a truncated hash still tells you whether
 *                      two attempts signed the same thing
 *   `authorization`    fully hidden; there is no useful prefix
 *   `cookie`           fully hidden
 *   `idempotency-key`  kept — it is not a credential, and it is the single
 *                      most useful field when tracing a retried write
 *   `x-api-key`        kept — a public identifier, and hiding it makes logs
 *                      useless for working out which key was in play
 *   `x-nonce`          kept — per-request and worthless to an attacker, but
 *                      the fastest way to confirm each attempt re-signed
 */

/** Header names replaced entirely. */
export const HIDDEN_HEADERS = Object.freeze(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);

/** Header names shown as a short prefix. */
export const TRUNCATED_HEADERS = Object.freeze(['x-signature', 'x-webhook-signature']);

export const REDACTED = '[redacted]';

/**
 * Show enough of a value to compare two of them, never enough to reuse one.
 *
 * Eight hex characters is 32 bits: two different signatures colliding in a
 * single log is not a realistic worry, and 32 bits of a SHA-256 HMAC is not a
 * meaningful head start on forging the rest.
 */
export function truncate(value, keep = 8) {
  if (typeof value !== 'string') return REDACTED;
  if (value.length <= keep) return REDACTED;

  return `${value.slice(0, keep)}…(${value.length})`;
}

/**
 * Redact a header bag. Returns a new object; the input is untouched, because
 * a redactor that mutated the headers being sent would break the signature.
 */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};

  const out = {};

  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();

    if (HIDDEN_HEADERS.includes(name)) out[name] = REDACTED;
    else if (TRUNCATED_HEADERS.includes(name)) out[name] = truncate(value);
    else out[name] = value;
  }

  return out;
}

/**
 * Redact a URL's query string.
 *
 * Query parameters are logged constantly and are the other place credentials
 * end up, usually because an API accepted a token there once and someone
 * copied the pattern.
 */
export function redactUrl(url, sensitiveParams = ['token', 'access_token', 'api_key', 'apikey', 'secret', 'signature']) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  let changed = false;
  for (const name of [...parsed.searchParams.keys()]) {
    if (sensitiveParams.includes(name.toLowerCase())) {
      parsed.searchParams.set(name, REDACTED);
      changed = true;
    }
  }

  return changed ? parsed.toString() : url;
}

/**
 * Build the object handed to `onRequest`.
 *
 * The body is deliberately **not** included. It is the largest thing in the
 * request and the most likely to hold card numbers, names and addresses;
 * logging it by default would trade one leak for a worse one. Anyone who
 * genuinely needs it has it at the call site already.
 */
export function requestEvent({ method, url, headers, attempt, idempotencyKey }) {
  return {
    method: method.toUpperCase(),
    url: redactUrl(url),
    headers: redactHeaders(headers),
    attempt,
    idempotencyKey: idempotencyKey ?? null,
  };
}

/** Build the object handed to `onResponse`. */
export function responseEvent({ method, url, status, headers, durationMs, attempt }) {
  return {
    method: method.toUpperCase(),
    url: redactUrl(url),
    status,
    headers: redactHeaders(headers),
    durationMs,
    attempt,
    requestId: headers?.['x-request-id'] ?? null,
  };
}
