/**
 * Circuit breaker.
 *
 * Retries handle a blip. This handles an outage, and the difference matters
 * because the same behaviour that rescues one failed request makes a hundred
 * of them worse.
 *
 * When a service is genuinely down, every request still costs a full timeout
 * before it fails — and with retries on, three of them. A queue of work that
 * would take a minute against a healthy service takes an hour against a dead
 * one, all of it spent waiting for connections that were never going to
 * answer. Meanwhile the retries burn the rate limit that recovery will need,
 * and the caller's own latency collapses under work that cannot succeed.
 *
 * So after enough consecutive failures the breaker opens and requests fail
 * immediately, without a socket. After a cooldown it lets exactly one through
 * — the *half-open* probe — and decides from that single result whether to
 * close or to wait again.
 *
 * Two details that are easy to get wrong and both testable:
 *
 * **Only transport-level failures count.** A 404 is a working service giving a
 * correct answer; counting it toward a breaker means a caller looping over
 * missing records trips the breaker for everyone else. A 401 is the same. What
 * counts is what says the service itself is unreachable or broken: network
 * errors, timeouts, and 5xx.
 *
 * **Half-open admits one request, not one burst.** The obvious implementation
 * flips a flag and lets everything waiting through, which is precisely the
 * thundering herd that knocked the service over. One probe answers the
 * question; the rest can wait for its verdict.
 */

import { TerminalError } from './errors.js';
import { isRetryableError } from './retry.js';

export const CIRCUIT_STATE = Object.freeze({
  closed: 'closed',
  open: 'open',
  halfOpen: 'half-open',
});

export const DEFAULT_BREAKER = Object.freeze({
  /** Consecutive failures before opening. */
  threshold: 5,
  /** How long to stay open before admitting a probe. */
  cooldownMs: 30_000,
});

/** Thrown instead of sending, while the breaker is open. */
export class CircuitOpenError extends TerminalError {
  constructor(message, { retryAfterMs, failures, lastError } = {}) {
    super(message, { cause: lastError });
    /** Milliseconds until the next probe is admitted. */
    this.retryAfterMs = retryAfterMs ?? 0;
    this.failures = failures ?? 0;
    /** The failure that opened the circuit, for context. */
    this.lastError = lastError ?? null;
  }
}

/**
 * Whether a failure says anything about the service's health.
 *
 * Deliberately the same predicate the retry policy uses. If an error is not
 * worth retrying it is not evidence of an outage either, and keeping the two
 * in step means there is one answer to "is this the service's fault" rather
 * than two that can drift apart.
 */
export function countsAsFailure(error) {
  return isRetryableError(error);
}

export class CircuitBreaker {
  #threshold;
  #cooldownMs;
  #now;

  #state = CIRCUIT_STATE.closed;
  #failures = 0;
  #openedAt = 0;
  #lastError = null;
  /** True while a half-open probe is in flight, so only one is. */
  #probing = false;

  constructor({ threshold, cooldownMs, now = Date.now } = {}) {
    // `??` rather than spreading over the defaults: an explicit `undefined`
    // wins a spread, so `{ ...DEFAULT_BREAKER, cooldownMs }` with no
    // cooldownMs passed erases the default rather than keeping it.
    const effectiveThreshold = threshold ?? DEFAULT_BREAKER.threshold;
    const effectiveCooldown = cooldownMs ?? DEFAULT_BREAKER.cooldownMs;

    if (!Number.isInteger(effectiveThreshold) || effectiveThreshold < 1) {
      throw new RangeError(`threshold must be a positive integer, got ${threshold}`);
    }
    if (!(effectiveCooldown >= 0) || !Number.isFinite(effectiveCooldown)) {
      throw new RangeError(`cooldownMs must be a non-negative number, got ${cooldownMs}`);
    }

    this.#threshold = effectiveThreshold;
    this.#cooldownMs = effectiveCooldown;
    this.#now = now;
  }

  get state() {
    this.#maybeHalfOpen();
    return this.#state;
  }

  get failures() {
    return this.#failures;
  }

  /** Milliseconds until the next probe, or 0 when requests are flowing. */
  get retryAfterMs() {
    if (this.state !== CIRCUIT_STATE.open) return 0;
    return Math.max(0, this.#cooldownMs - (this.#now() - this.#openedAt));
  }

  #maybeHalfOpen() {
    if (this.#state !== CIRCUIT_STATE.open) return;
    if (this.#now() - this.#openedAt < this.#cooldownMs) return;

    this.#state = CIRCUIT_STATE.halfOpen;
    this.#probing = false;
  }

  /**
   * Ask permission to send. Throws `CircuitOpenError` when refused.
   *
   * The half-open branch admits the first caller and refuses the rest: one
   * probe answers the question, and letting the whole queue through is the
   * thundering herd the breaker exists to prevent.
   */
  assertAvailable() {
    this.#maybeHalfOpen();

    if (this.#state === CIRCUIT_STATE.closed) return;

    if (this.#state === CIRCUIT_STATE.halfOpen && !this.#probing) {
      this.#probing = true;
      return;
    }

    throw new CircuitOpenError(
      this.#state === CIRCUIT_STATE.halfOpen
        ? 'Circuit is half-open and a probe is already in flight'
        : `Circuit is open after ${this.#failures} consecutive failures`,
      { retryAfterMs: this.retryAfterMs, failures: this.#failures, lastError: this.#lastError },
    );
  }

  /** A request succeeded: the service is answering, so reset completely. */
  recordSuccess() {
    this.#state = CIRCUIT_STATE.closed;
    this.#failures = 0;
    this.#lastError = null;
    this.#probing = false;
  }

  /**
   * A request failed. Only failures that implicate the service count.
   *
   * A failed probe reopens the circuit for a **full** cooldown rather than
   * letting the next caller straight back in — the probe just demonstrated
   * the service is still down.
   */
  recordFailure(error) {
    if (!countsAsFailure(error)) {
      // A 404 or a 401 is a working service. It should not count toward an
      // outage, and it should not reset the count either — an intermittent
      // outage interleaved with 404s would never trip.
      this.#probing = false;
      return;
    }

    this.#lastError = error;
    this.#failures += 1;
    this.#probing = false;

    if (this.#state === CIRCUIT_STATE.halfOpen || this.#failures >= this.#threshold) {
      this.#state = CIRCUIT_STATE.open;
      this.#openedAt = this.#now();
    }
  }

  /** Force the breaker closed. Mostly for tests and operator tooling. */
  reset() {
    this.recordSuccess();
  }
}

/** Normalise the constructor option into a breaker, or null when disabled. */
export function resolveBreaker(option, now = Date.now) {
  if (option === false || option === undefined || option === null) return null;
  if (option instanceof CircuitBreaker) return option;
  if (option === true) return new CircuitBreaker({ now });

  return new CircuitBreaker({ ...option, now });
}
