/**
 * Conditional requests: `ETag` in, `If-None-Match` out, `304` handled.
 *
 * Polling a list endpoint every thirty seconds re-downloads the same payload
 * every time. A conditional request replaces that with a `304 Not Modified` —
 * no body on the wire — and the client serves what it already had.
 *
 * The part specific to a signed API, and the reason this is not just a `Map`:
 *
 * **The cache key must exclude the signature.** Every request carries a fresh
 * timestamp, a fresh nonce and therefore a fresh signature. Key on the headers
 * and the cache never hits; key on the URL alone and two different bodies
 * collide. What identifies a response is the method, the signed path and the
 * canonical query — the same canonical form the signature is built from, which
 * is convenient, because it is already order-independent.
 *
 * **A 304 has no body.** Handing the caller a response with `data: null`
 * because the server correctly said "unchanged" would be a bizarre way to
 * reward a cache hit. The stored body is substituted, and the status the
 * caller sees is the stored one, not the 304 — the point of the mechanism is
 * that the caller should not have to know it happened.
 *
 * Only `GET` and `HEAD` are cached. A conditional `POST` means something quite
 * different, and nothing here should be guessing about it.
 */

export const CACHEABLE_METHODS = Object.freeze(['GET', 'HEAD']);

export const DEFAULT_CACHE = Object.freeze({
  /** Entries to keep. Oldest-used are evicted first. */
  maxEntries: 100,
  methods: CACHEABLE_METHODS,
});

/**
 * The identity of a response, as far as caching is concerned.
 *
 * Deliberately built from the canonical query rather than the raw object, so
 * `?a=1&b=2` and `?b=2&a=1` are one entry rather than two — for exactly the
 * reason the signature does the same thing.
 */
export function cacheKey(method, path, canonicalQuery) {
  return `${method.toUpperCase()} ${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
}

/**
 * A bounded LRU of validated responses.
 *
 * Bounded because an unbounded cache in a long-running process is a memory
 * leak with a friendly name — a paginating job walking a million cursors would
 * hold every page it ever saw.
 */
export class ResponseCache {
  #maxEntries;
  #entries = new Map();

  constructor({ maxEntries } = {}) {
    const limit = maxEntries ?? DEFAULT_CACHE.maxEntries;

    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`maxEntries must be a positive integer, got ${maxEntries}`);
    }

    this.#maxEntries = limit;
  }

  get size() {
    return this.#entries.size;
  }

  get maxEntries() {
    return this.#maxEntries;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;

    // Re-insert so this becomes the most recently used. `Map` preserves
    // insertion order, which is the whole trick.
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    return entry;
  }

  set(key, entry) {
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    while (this.#entries.size > this.#maxEntries) {
      // First key is the least recently used.
      this.#entries.delete(this.#entries.keys().next().value);
    }
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }
}

/** Normalise the constructor option into a cache, or null when disabled. */
export function resolveCache(option) {
  if (option === false || option === undefined || option === null) return null;
  if (option instanceof ResponseCache) return option;
  if (option === true) return new ResponseCache();

  return new ResponseCache(option);
}

/** Whether a method may be served from, or stored in, the cache. */
export function isCacheable(method, methods = CACHEABLE_METHODS) {
  return methods.some((m) => m.toUpperCase() === method.toUpperCase());
}

/**
 * The validator to send back, if there is one.
 *
 * `ETag` is preferred over `Last-Modified` because it is exact: a resource can
 * change twice within the same second, and a date cannot express that.
 */
export function validatorHeaders(entry) {
  if (!entry) return {};
  if (entry.etag) return { 'if-none-match': entry.etag };
  if (entry.lastModified) return { 'if-modified-since': entry.lastModified };

  return {};
}

/** Whether a response is worth remembering. */
export function isStorable(status, headers) {
  if (status !== 200) return false;

  return Boolean(headers?.etag || headers?.['last-modified']);
}
