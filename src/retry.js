/**
 * Retry policy.
 *
 * The two decisions that matter here are *what* to retry and *when*, and both
 * have a wrong answer that looks fine in testing.
 *
 * What: only failures that a later attempt could plausibly resolve, and only
 * on methods where sending the request twice means the same thing as sending
 * it once. Replaying a `POST /capture` because the response timed out is how a
 * customer gets charged twice — the request may well have succeeded, with only
 * the reply lost. So non-idempotent methods are opt-in, never automatic.
 *
 * When: with full jitter. A fixed backoff resynchronises every client that
 * failed during the same outage, so they all return together and knock the
 * service over again on the first retry.
 */

import { ApiError, NetworkError, RateLimitError, TimeoutError } from './errors.js';

/** Methods where a replay has the same effect as a single call. */
export const IDEMPOTENT_METHODS = Object.freeze(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

export const DEFAULT_RETRY_POLICY = Object.freeze({
  /** Attempts *after* the first, so 2 means up to 3 requests in total. */
  retries: 2,
  minDelayMs: 200,
  maxDelayMs: 10_000,
  factor: 2,
  methods: IDEMPOTENT_METHODS,
});

/**
 * Decide whether an error is worth another attempt.
 *
 * Deliberately excluded: `AuthError` (a bad signature will still be bad in
 * 200ms), `ConfigError` and `SignatureError` (caller bugs), and every other
 * 4xx — the request is malformed and repeating it just burns rate limit.
 */
export function isRetryableError(error) {
  if (error instanceof NetworkError || error instanceof TimeoutError) return true;
  if (error instanceof RateLimitError) return true;

  // `AuthError` also extends ApiError, but its status never satisfies this.
  if (error instanceof ApiError) return error.status >= 500 || error.status === 408;

  return false;
}

/**
 * Resolve the effective policy for one call.
 *
 * `retry: false` disables retries. `retry: true` enables them *and* bypasses
 * the method allowlist — the explicit opt-in a POST needs. An object merges
 * into the client policy with the allowlist still applied.
 *
 * `replaySafe` lifts the allowlist too, and unlike `retry: true` it is not a
 * caller taking responsibility — it means the request carries an idempotency
 * key, so a replay is safe by construction rather than by promise.
 */
export function resolvePolicy(clientPolicy, callOption, method, { replaySafe = false } = {}) {
  if (callOption === false) return { ...clientPolicy, retries: 0 };

  const policy = callOption === true || callOption === undefined
    ? clientPolicy
    : { ...clientPolicy, ...callOption };

  // An explicit `retry: true` is the caller taking responsibility for a
  // replay, so the allowlist does not apply.
  if (callOption === true) return policy;

  const allowed =
    replaySafe || policy.methods.some((m) => m.toUpperCase() === method.toUpperCase());
  return allowed ? policy : { ...policy, retries: 0 };
}

/**
 * How long to wait before attempt `attempt` (0-based: 0 is the first retry).
 *
 * A `Retry-After` from the server always wins over a locally computed guess —
 * it is the only party that knows when capacity returns — but it is still
 * capped, so a hostile or misconfigured header cannot park the caller for an
 * hour.
 */
export function computeDelay(attempt, policy, retryAfterMs = null, random = Math.random) {
  if (retryAfterMs != null) return Math.min(retryAfterMs, policy.maxDelayMs);

  const ceiling = Math.min(policy.maxDelayMs, policy.minDelayMs * policy.factor ** attempt);

  // Full jitter — uniform over [0, ceiling]. Equal-jitter and fixed backoff
  // both leave a thundering herd; this is the variant that actually spreads.
  return Math.round(random() * ceiling);
}

/**
 * Abortable sleep.
 *
 * A caller who aborts mid-backoff expects to be released immediately, not
 * when the timer they can no longer influence happens to fire.
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('aborted'));
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
