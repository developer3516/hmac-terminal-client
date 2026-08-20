/**
 * Client-side rate limiting.
 *
 * This exists because of a confusion that `bulk` makes easy to fall into:
 * **bounded concurrency is not a bounded rate.** A pool of four workers against
 * an endpoint that answers in 10ms issues four hundred requests a second. The
 * concurrency setting is doing exactly what it promised — never more than four
 * in flight — while the server sees a flood.
 *
 * Retries do not solve it either. Backoff is what happens *after* the limiter
 * has already rejected you: the 429 was served, counted, and probably logged
 * against your key. Backing off politely from a limit you keep hitting is
 * slower than not hitting it, and on APIs that penalise repeat offenders it is
 * worse than slower.
 *
 * So this paces requests before they leave. A token bucket, because it is the
 * shape real limiters use: a sustained rate with a burst allowance, so a
 * caller idle for a minute can send a short burst immediately rather than
 * being throttled to the average by a scheme that has no memory.
 */

import { sleep } from './retry.js';

export const DEFAULT_RATE_LIMIT = Object.freeze({
  requestsPerSecond: 10,
  /** Tokens available after an idle period. Defaults to one second's worth. */
  burst: null,
});

/**
 * A token bucket.
 *
 * Refills continuously rather than on a timer: tokens are computed from the
 * elapsed time whenever one is asked for. A timer-based refill would let a
 * caller who happened to arrive just after a tick wait a full interval for a
 * token that was, in truth, already three-quarters earned.
 */
export class TokenBucket {
  #capacity;
  #tokens;
  #ratePerMs;
  #now;
  #last;

  /**
   * @param {object}   options
   * @param {number}   options.requestsPerSecond
   * @param {number}  [options.burst]  capacity; defaults to one second's worth
   * @param {Function}[options.now]    injectable clock, for tests
   */
  constructor({ requestsPerSecond, burst = null, now = Date.now } = {}) {
    if (!(requestsPerSecond > 0) || !Number.isFinite(requestsPerSecond)) {
      throw new RangeError(`requestsPerSecond must be a positive number, got ${requestsPerSecond}`);
    }

    const capacity = burst ?? Math.max(1, Math.floor(requestsPerSecond));
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`burst must be a positive integer, got ${burst}`);
    }

    this.#capacity = capacity;
    // Start full. A client that has just been constructed has, by definition,
    // not consumed anything.
    this.#tokens = capacity;
    this.#ratePerMs = requestsPerSecond / 1000;
    this.#now = now;
    this.#last = now();
  }

  get capacity() {
    return this.#capacity;
  }

  /** Tokens available right now, after accounting for elapsed time. */
  get tokens() {
    this.#refill();
    return this.#tokens;
  }

  #refill() {
    const now = this.#now();
    const elapsed = now - this.#last;
    if (elapsed <= 0) return;

    this.#last = now;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#ratePerMs);
  }

  /**
   * How long until a token is available, in milliseconds. Zero when one is.
   */
  delayMs() {
    this.#refill();
    if (this.#tokens >= 1) return 0;

    return Math.ceil((1 - this.#tokens) / this.#ratePerMs);
  }

  /**
   * Take a token if one is available.
   * @returns {boolean} whether it was taken
   */
  tryTake() {
    this.#refill();
    if (this.#tokens < 1) return false;

    this.#tokens -= 1;
    return true;
  }

  /**
   * Wait for a token, then take it.
   *
   * The loop is not defensive padding: several callers can be waiting on the
   * same bucket, and the one that wakes first takes the token the others were
   * also waiting for. Without re-checking, the losers would proceed on a
   * token that no longer exists.
   */
  async take(signal) {
    for (;;) {
      if (this.tryTake()) return;

      const wait = this.delayMs();
      await sleep(wait > 0 ? wait : 1, signal);
    }
  }
}

/** Normalise the constructor option into a bucket, or null when disabled. */
export function resolveRateLimit(option, now = Date.now) {
  if (option === false || option === undefined || option === null) return null;
  if (option instanceof TokenBucket) return option;

  const config =
    typeof option === 'number'
      ? { requestsPerSecond: option }
      : { ...DEFAULT_RATE_LIMIT, ...option };

  return new TokenBucket({ ...config, now });
}
