/**
 * Idempotency keys.
 *
 * This module exists to settle something the retry policy had to leave open.
 *
 * Retries deliberately skip `POST` and `PATCH`, because when a capture times
 * out the request may well have reached the server and succeeded with only the
 * reply lost — replaying it charges the customer twice. That is the correct
 * default, but it is a *refusal*, not a solution: the request that timed out
 * still needs to happen, and the caller is left to work out whether it already
 * did.
 *
 * An idempotency key solves it properly. The client sends a key with the
 * write; the server records it against the outcome; a second request bearing
 * the same key returns the first result instead of performing the work again.
 * Replay stops being dangerous, so the retry can simply happen.
 *
 * The load-bearing detail is that the key must be **generated once per logical
 * request and reused across every attempt**. A key minted per attempt is worse
 * than no key at all: it looks like protection, costs a header, and still
 * double-charges — while making everyone believe the problem is handled.
 */

import { randomUUID } from 'node:crypto';

export const DEFAULT_IDEMPOTENCY = Object.freeze({
  header: 'idempotency-key',
  /** Methods that get a key. The safe ones do not need one. */
  methods: Object.freeze(['POST', 'PATCH']),
  generate: randomUUID,
});

/** Normalise the constructor option into a policy, or null when disabled. */
export function resolveIdempotencyConfig(option) {
  if (option === false || option === undefined || option === null) return null;
  if (option === true) return { ...DEFAULT_IDEMPOTENCY };

  return { ...DEFAULT_IDEMPOTENCY, ...option };
}

/**
 * The key for one logical request, or null when it should not carry one.
 *
 * An explicit `idempotencyKey` always wins, including on a method the policy
 * would otherwise skip — a caller passing one has a reason, usually
 * deduplicating across process restarts where the key comes from their own
 * job record rather than from here.
 */
export function keyFor(config, method, explicitKey) {
  if (explicitKey !== undefined && explicitKey !== null) {
    if (typeof explicitKey !== 'string' || explicitKey.length === 0) {
      throw new TypeError('idempotencyKey must be a non-empty string');
    }
    return explicitKey;
  }

  if (!config) return null;
  if (!config.methods.some((m) => m.toUpperCase() === method.toUpperCase())) return null;

  return config.generate();
}
