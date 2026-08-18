/**
 * Pagination as an async iterator.
 *
 * The naive version of this is a `while (cursor)` loop that accumulates every
 * page into an array and returns it. That has two problems, and the second one
 * is the reason this module exists.
 *
 * It holds the whole result set in memory, so listing 200,000 terminals to act
 * on each one costs 200,000 objects of heap for no reason. `for await` hands
 * them over one page at a time and lets the caller `break`.
 *
 * And it trusts the server to eventually say stop. A misconfigured endpoint
 * that echoes the cursor it was given — or a `next` link pointing at the
 * current page — turns that loop into an unkillable request flood against the
 * API you are trying to be a good citizen of. Nobody writes a guard for that
 * until it happens once. There is one here.
 */

import { TerminalError } from './errors.js';

/** Raised when pagination cannot safely continue. */
export class PaginationError extends TerminalError {
  constructor(message, { pages, cursor, cause } = {}) {
    super(message, { cause });
    /** How many pages had been fetched when this was raised. */
    this.pages = pages ?? 0;
    this.cursor = cursor ?? null;
  }
}

/**
 * Default cursor extractor.
 *
 * Checks the shapes APIs actually use, in order, and returns `null` when none
 * are present — which is how pagination terminates. Anything more exotic gets
 * an explicit `cursorFrom`.
 */
export function defaultCursorFrom(data) {
  if (!data || typeof data !== 'object') return null;

  for (const key of ['next_cursor', 'nextCursor', 'next', 'cursor']) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

/**
 * Default item extractor. Falls back to the payload itself when it is already
 * an array, which is common for endpoints that paginate by header.
 */
export function defaultItemsFrom(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  for (const key of ['items', 'data', 'results']) {
    if (Array.isArray(data[key])) return data[key];
  }

  return [];
}

/**
 * Walk pages until the server stops handing out cursors.
 *
 * `fetchPage(cursor)` is called with `undefined` for the first page and the
 * extracted cursor thereafter. Yields whatever it resolves to.
 *
 * @param {(cursor: unknown) => Promise<any>} fetchPage
 * @param {object}   [options]
 * @param {Function} [options.cursorFrom]  page -> next cursor, or null to stop
 * @param {number}   [options.maxPages]    safety valve; throws when tripped
 * @param {AbortSignal} [options.signal]
 */
export async function* paginate(fetchPage, options = {}) {
  const { cursorFrom = defaultCursorFrom, maxPages = Infinity, signal } = options;

  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');

  const seen = new Set();
  let cursor;
  let pages = 0;

  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new PaginationError('aborted', { pages, cursor });

    const page = await fetchPage(cursor);
    pages += 1;
    yield page;

    const next = cursorFrom(page);
    if (next === null || next === undefined) return;

    // A cursor we have already followed means the server is pointing us
    // backwards. Continuing would loop forever, so stop loudly instead of
    // hammering the endpoint.
    const key = typeof next === 'object' ? JSON.stringify(next) : String(next);
    if (seen.has(key)) {
      throw new PaginationError(
        `Pagination looped: cursor ${key} was already followed after ${pages} pages`,
        { pages, cursor: next },
      );
    }
    seen.add(key);

    // Deliberately after the loop check: hitting the cap is a distinct
    // failure from looping, and conflating them hides which one happened.
    if (pages >= maxPages) {
      throw new PaginationError(
        `Pagination stopped at the ${maxPages}-page limit with more pages available — ` +
          'raise maxPages, or break out of the loop when you have enough',
        { pages, cursor: next },
      );
    }

    cursor = next;
  }
}
