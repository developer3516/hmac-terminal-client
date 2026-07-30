/**
 * Error taxonomy for the client.
 *
 * Every error thrown by this package extends `TerminalError`, so callers can
 * distinguish "the request never left" from "the server said no" without
 * string-matching messages.
 */

export class TerminalError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
  }
}

/** The request was signed or built incorrectly — a bug on the caller's side. */
export class ConfigError extends TerminalError {}

/** The signing input was malformed (bad key, unserialisable body, clock skew). */
export class SignatureError extends TerminalError {}

/** The request could not be delivered: DNS, TCP, TLS, or a dropped socket. */
export class NetworkError extends TerminalError {}

/** The request exceeded the configured timeout and was aborted locally. */
export class TimeoutError extends TerminalError {
  constructor(timeoutMs, options = {}) {
    super(`Request timed out after ${timeoutMs}ms`, options);
    this.timeoutMs = timeoutMs;
  }
}

/** The server responded with a non-2xx status. */
export class ApiError extends TerminalError {
  constructor(message, { status, code, body, requestId, headers, retryAfterMs, cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code ?? null;
    this.body = body ?? null;
    this.requestId = requestId ?? null;
    this.headers = headers ?? {};
    /** Parsed `Retry-After`, or null when the server sent no hint. */
    this.retryAfterMs = retryAfterMs ?? null;
  }

  /**
   * Build the most specific error subclass the status warrants.
   */
  static from(status, { body, headers = {}, requestId } = {}) {
    const code = pluck(body, 'code');
    const message =
      pluck(body, 'message') ??
      pluck(body, 'error') ??
      `Request failed with status ${status}`;

    // 429 is the obvious carrier of `Retry-After`, but 503 uses it too, and a
    // retry loop that only reads the header on one of them ignores the
    // server exactly when it is asking hardest to be left alone.
    const shared = {
      status,
      code,
      body,
      headers,
      requestId,
      retryAfterMs: parseRetryAfter(headers['retry-after']),
    };

    if (status === 401 || status === 403) return new AuthError(message, shared);
    if (status === 429) return new RateLimitError(message, shared);

    return new ApiError(message, shared);
  }
}

/** 401/403 — the signature, key id, or permissions were rejected. */
export class AuthError extends ApiError {}

/** 429 — throttled. Carries `retryAfterMs` like any other `ApiError`. */
export class RateLimitError extends ApiError {}

function pluck(body, key) {
  if (body && typeof body === 'object' && typeof body[key] === 'string') {
    return body[key];
  }
  return undefined;
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date. Both are legal, and
 * servers use both, so handle each rather than assuming the easy one.
 */
export function parseRetryAfter(value) {
  if (value == null) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;

  return Math.max(0, date - Date.now());
}
