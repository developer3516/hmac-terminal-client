/**
 * Bounded-concurrency batch execution.
 *
 * Two things make a bulk helper worth writing rather than reaching for
 * `Promise.all`.
 *
 * The first is the bound. `Promise.all(items.map(send))` over ten thousand
 * items opens ten thousand sockets, trips the rate limiter on the first
 * hundred, and turns the rest into retry pressure. A worker pool keeps a fixed
 * number in flight and feeds from a queue.
 *
 * The second is partial failure, which in a batch is the normal case rather
 * than the exceptional one. `Promise.all` rejects on the first error and
 * discards every other result — including the successes. For a batch of
 * writes that is the worst possible outcome: the caller now knows something
 * failed but not what already went through, and cannot safely retry any of it.
 * So this settles everything by default, and even the fail-fast path hands
 * back what it had.
 */

import { TerminalError } from './errors.js';

export const DEFAULT_CONCURRENCY = 4;

/**
 * Thrown only when `stopOnError` is set.
 *
 * Carries `results` — knowing which items already went through is the whole
 * point of stopping early rather than the least of it.
 */
export class BulkError extends TerminalError {
  constructor(message, { results, index, cause } = {}) {
    super(message, { cause });
    this.results = results ?? [];
    /** Position of the item that failed. */
    this.index = index ?? -1;
  }
}

/**
 * Run `handler` over `items`, at most `concurrency` at a time.
 *
 * Resolves to one settled entry per input, **in input order** regardless of
 * completion order:
 *
 *   `{ status: 'fulfilled', value }`
 *   `{ status: 'rejected',  reason }`
 *   `{ status: 'skipped' }`   — never attempted (aborted or stopped early)
 *
 * `skipped` is deliberately distinct from `rejected`. After a batch of
 * payments, "we never sent this one" and "we sent it and it failed" call for
 * completely different follow-up, and collapsing them into a single failure
 * state loses the distinction exactly when it matters most.
 *
 * @param {Iterable} items
 * @param {(item: any, index: number) => Promise<any>} handler
 * @param {object}  [options]
 * @param {number}  [options.concurrency=4]
 * @param {boolean} [options.stopOnError=false]  throw BulkError on first failure
 * @param {AbortSignal} [options.signal]
 */
export async function pool(items, handler, options = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, stopOnError = false, signal } = options;

  if (typeof handler !== 'function') {
    throw new TypeError('handler must be a function');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }

  const list = Array.from(items);
  // Pre-filling means an early exit leaves every unattempted slot correctly
  // marked, rather than leaving holes the caller has to interpret.
  const results = list.map(() => ({ status: 'skipped' }));

  let cursor = 0;
  let stopped = false;
  let failure = null;

  const worker = async () => {
    for (;;) {
      if (stopped || signal?.aborted) return;

      const index = cursor;
      if (index >= list.length) return;
      cursor += 1;

      try {
        results[index] = { status: 'fulfilled', value: await handler(list[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };

        if (stopOnError) {
          stopped = true;
          // Keep the earliest failure by input position, not by which worker
          // happened to lose the race.
          if (!failure || index < failure.index) failure = { index, reason };
          return;
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, worker);
  await Promise.all(workers);

  if (failure) {
    throw new BulkError(`Bulk operation failed at index ${failure.index}: ${failure.reason.message}`, {
      results,
      index: failure.index,
      cause: failure.reason,
    });
  }

  return results;
}

/**
 * Split settled results into three arrays, each entry keeping its input index.
 *
 * Bulk callers almost always want "which succeeded, which failed, which never
 * ran" rather than the flat list, and reconstructing the index by hand after
 * a filter is an easy thing to get subtly wrong.
 */
export function partition(results) {
  const fulfilled = [];
  const rejected = [];
  const skipped = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') fulfilled.push({ index, value: result.value });
    else if (result.status === 'rejected') rejected.push({ index, reason: result.reason });
    else skipped.push({ index });
  });

  return { fulfilled, rejected, skipped };
}
