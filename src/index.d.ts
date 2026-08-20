/**
 * Type declarations for hmac-terminal-client.
 *
 * Hand-written rather than generated. Adding TypeScript purely to emit these
 * would put the first entry in a `devDependencies` block that is otherwise
 * empty and deliberately so — the package installs nothing, and that is worth
 * more than a build step.
 *
 * `test/types.test.js` keeps this file honest by asserting that every runtime
 * export is declared here and that nothing is declared that does not exist.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export declare class TerminalError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}

/** The client was constructed wrong — a caller bug. */
export declare class ConfigError extends TerminalError {}

/** The signing input was malformed. */
export declare class SignatureError extends TerminalError {}

/** DNS, TCP, TLS, or a dropped socket. */
export declare class NetworkError extends TerminalError {}

/** Aborted locally after the configured timeout. */
export declare class TimeoutError extends TerminalError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, options?: { cause?: unknown });
}

export interface ApiErrorOptions {
  status?: number;
  code?: string | null;
  body?: unknown;
  requestId?: string | null;
  headers?: Record<string, string>;
  retryAfterMs?: number | null;
  cause?: unknown;
}

/** A non-2xx response. */
export declare class ApiError extends TerminalError {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
  readonly requestId: string | null;
  readonly headers: Record<string, string>;
  /** Parsed `Retry-After`, or null when the server sent no hint. */
  readonly retryAfterMs: number | null;

  constructor(message: string, options?: ApiErrorOptions);
  static from(
    status: number,
    context?: { body?: unknown; headers?: Record<string, string>; requestId?: string | null },
  ): ApiError;
}

/** 401 or 403. */
export declare class AuthError extends ApiError {}

/** 429. */
export declare class RateLimitError extends ApiError {}

/** Parse a `Retry-After` header in either legal form. Never negative. */
export declare function parseRetryAfter(value: string | null | undefined): number | null;

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export declare const SIGNATURE_VERSION: 'v1';
export declare const DEFAULT_TOLERANCE_MS: number;

export declare const HEADER: {
  readonly keyId: 'x-api-key';
  readonly timestamp: 'x-timestamp';
  readonly nonce: 'x-nonce';
  readonly signature: 'x-signature';
  readonly version: 'x-signature-version';
};

/** A query object, a pair array, or `URLSearchParams`. */
export type QueryInput =
  | Record<string, string | number | boolean | null | undefined | Array<string | number | boolean>>
  | Array<[string, unknown]>
  | URLSearchParams;

/** Anything the signer knows how to hash. Non-buffer objects are JSON encoded. */
export type BodyInput = string | Uint8Array | Record<string, unknown> | unknown[] | null | undefined;

export type HeaderInput = Headers | Record<string, string | undefined>;

export interface SignedRequest {
  canonicalRequest: string;
  signature: string;
  timestamp: number;
  nonce: string;
  headers: Record<string, string>;
}

export interface VerifyResult {
  valid: boolean;
  reason: string | null;
  timestamp?: number;
  nonce?: string;
}

export declare function rfc3986(value: unknown): string;
export declare function canonicalQuery(query?: QueryInput | null): string;
export declare function canonicalPath(path: string): string;
export declare function hashBody(body?: BodyInput): string;
export declare function computeSignature(secret: string | Uint8Array, canonicalRequest: string): string;
export declare function generateNonce(): string;
export declare function constantTimeEquals(a: unknown, b: unknown): boolean;

export declare function buildCanonicalRequest(input: {
  method: string;
  path: string;
  query?: QueryInput | null;
  timestamp: number;
  nonce: string;
  body?: BodyInput;
}): string;

export declare function signRequest(input: {
  keyId: string;
  secret: string | Uint8Array;
  method: string;
  path: string;
  query?: QueryInput | null;
  body?: BodyInput;
  timestamp?: number;
  nonce?: string;
}): SignedRequest;

export declare function verifyRequest(input: {
  secret: string | Uint8Array;
  headers: HeaderInput;
  method: string;
  path: string;
  query?: QueryInput | null;
  body?: BodyInput;
  toleranceMs?: number;
  now?: number;
}): VerifyResult;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export declare const WEBHOOK_SIGNATURE_VERSION: 'v1';
export declare const WEBHOOK_HEADER: 'x-webhook-signature';
export declare const DEFAULT_WEBHOOK_TOLERANCE_MS: number;

/**
 * The raw bytes as delivered. A parsed object is deliberately not accepted —
 * re-serialising changes the bytes and the signature will not match.
 */
export type RawBody = string | Uint8Array;

export interface ParsedWebhookHeader {
  timestamp: number | null;
  signatures: string[];
  /** `vN` schemes present but not understood, so a receiver can say so. */
  unknownVersions: string[];
}

export declare function buildWebhookPayload(timestamp: number, rawBody: RawBody): Uint8Array;

export declare function computeWebhookSignature(
  secret: string | Uint8Array,
  timestamp: number,
  rawBody: RawBody,
): string;

export declare function parseWebhookHeader(header: string | null | undefined): ParsedWebhookHeader;

export declare function signWebhook(input: {
  secret?: string | Uint8Array;
  /** Several secrets emit several `v1` entries — what a sender does mid rotation. */
  secrets?: Array<string | Uint8Array>;
  payload: RawBody;
  timestamp?: number;
}): { header: string; timestamp: number; signatures: string[] };

export declare function verifyWebhook(input: {
  secret?: string | Uint8Array | Array<string | Uint8Array>;
  secrets?: Array<string | Uint8Array>;
  header: string;
  payload: RawBody;
  toleranceMs?: number;
  now?: number;
}): VerifyResult;

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Attempts *after* the first. */
  retries: number;
  minDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** Methods eligible for an automatic replay. */
  methods: readonly string[];
}

export declare const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy>;
export declare const IDEMPOTENT_METHODS: readonly string[];

export declare function isRetryableError(error: unknown): boolean;

export declare function resolvePolicy(
  clientPolicy: RetryPolicy,
  callOption: boolean | Partial<RetryPolicy> | undefined,
  method: string,
  /** `replaySafe` lifts the method allowlist — the request carries a key. */
  context?: { replaySafe?: boolean },
): RetryPolicy;

export declare function computeDelay(
  attempt: number,
  policy: Pick<RetryPolicy, 'minDelayMs' | 'maxDelayMs' | 'factor'>,
  retryAfterMs?: number | null,
  random?: () => number,
): number;

/** Abortable sleep. Rejects if the signal aborts first. */
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  error: TerminalError;
  method: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

export declare const DEFAULT_CONCURRENCY: number;

export type SettledResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  /** Never attempted — aborted, or stopped early. Distinct from rejected. */
  | { status: 'skipped' };

export interface PoolOptions {
  concurrency?: number;
  stopOnError?: boolean;
  signal?: AbortSignal;
}

/** Thrown only when `stopOnError` is set. Carries the partial results. */
export declare class BulkError extends TerminalError {
  readonly results: Array<SettledResult<unknown>>;
  /** Position of the item that failed. */
  readonly index: number;

  constructor(message: string, options?: { results?: Array<SettledResult<unknown>>; index?: number; cause?: unknown });
}

export declare function pool<Item, Value>(
  items: Iterable<Item>,
  handler: (item: Item, index: number) => Promise<Value> | Value,
  options?: PoolOptions,
): Promise<Array<SettledResult<Value>>>;

export declare function partition<T>(results: Array<SettledResult<T>>): {
  fulfilled: Array<{ index: number; value: T }>;
  rejected: Array<{ index: number; reason: unknown }>;
  skipped: Array<{ index: number }>;
};

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  requestsPerSecond: number;
  /** Tokens available after an idle period. Defaults to one second's worth. */
  burst?: number | null;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export declare const DEFAULT_RATE_LIMIT: Readonly<{ requestsPerSecond: number; burst: number | null }>;

/** A continuously-refilling token bucket. Share one to share a quota. */
export declare class TokenBucket {
  constructor(options: RateLimitConfig);

  readonly capacity: number;
  /** Tokens available now, after accounting for elapsed time. */
  readonly tokens: number;

  /** Milliseconds until a token is available; zero when one is. */
  delayMs(): number;
  /** Take a token if one is free. */
  tryTake(): boolean;
  /** Wait for a token, then take it. Rejects if the signal aborts. */
  take(signal?: AbortSignal): Promise<void>;
}

export declare function resolveRateLimit(
  option: number | RateLimitConfig | TokenBucket | false | null | undefined,
  now?: () => number,
): TokenBucket | null;

// ---------------------------------------------------------------------------
// Redaction and observability
// ---------------------------------------------------------------------------

export declare const REDACTED: string;
/** Header names replaced entirely. */
export declare const HIDDEN_HEADERS: readonly string[];
/** Header names shown as a short prefix. */
export declare const TRUNCATED_HEADERS: readonly string[];

/** Enough to compare two values, never enough to reuse one. */
export declare function truncate(value: unknown, keep?: number): string;

/** Returns a new object; the input is never mutated. */
export declare function redactHeaders(headers: unknown): Record<string, string>;

export declare function redactUrl(url: string, sensitiveParams?: string[]): string;

export interface RequestEvent {
  method: string;
  url: string;
  headers: Record<string, string>;
  attempt: number;
  idempotencyKey: string | null;
  /** The body is deliberately absent — see the README. */
}

export interface ResponseEvent {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  durationMs: number;
  attempt: number;
  requestId: string | null;
}

export declare function requestEvent(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  attempt: number;
  idempotencyKey?: string | null;
}): RequestEvent;

export declare function responseEvent(input: {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  durationMs: number;
  attempt: number;
}): ResponseEvent;

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export interface IdempotencyConfig {
  /** Header carrying the key. Default `idempotency-key`. */
  header: string;
  /** Methods that get a key. Default `POST`, `PATCH`. */
  methods: readonly string[];
  generate: () => string;
}

export declare const DEFAULT_IDEMPOTENCY: Readonly<IdempotencyConfig>;

/** `true` takes the defaults, `false`/`undefined` disables, an object merges. */
export declare function resolveIdempotencyConfig(
  option: boolean | Partial<IdempotencyConfig> | null | undefined,
): IdempotencyConfig | null;

/**
 * The key for one logical request, or null. An explicit key always wins,
 * including on a method the policy would skip.
 */
export declare function keyFor(
  config: IdempotencyConfig | null,
  method: string,
  explicitKey?: string | null,
): string | null;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Raised when pagination cannot safely continue. */
export declare class PaginationError extends TerminalError {
  /** How many pages had been fetched when this was raised. */
  readonly pages: number;
  readonly cursor: unknown;

  constructor(message: string, options?: { pages?: number; cursor?: unknown; cause?: unknown });
}

/** Checks `next_cursor`, `nextCursor`, `next`, `cursor`; null ends the walk. */
export declare function defaultCursorFrom(data: unknown): unknown;

/** Unwraps `items`, `data` or `results`, or passes a bare array through. */
export declare function defaultItemsFrom<T = unknown>(data: unknown): T[];

export interface PaginateOptions {
  /** Page -> next cursor, or null/undefined to stop. */
  cursorFrom?: (page: any) => unknown;
  /** Safety valve. Throws `PaginationError` when tripped — never truncates. */
  maxPages?: number;
  signal?: AbortSignal;
}

export declare function paginate<Page>(
  fetchPage: (cursor: unknown) => Promise<Page>,
  options?: PaginateOptions,
): AsyncGenerator<Page, void, undefined>;

export interface ClientPaginateOptions extends RequestOptions {
  /** Query parameter carrying the cursor. Default `cursor`. */
  cursorParam?: string;
  /** Reads the *payload*, not the `{ status, headers, data }` wrapper. */
  cursorFrom?: (data: any, page: TerminalResponse) => unknown;
  maxPages?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TerminalClientOptions {
  /** Must be https, except on localhost / 127.0.0.1. */
  baseUrl: string;
  keyId: string;
  secret: string | Uint8Array;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  defaultHeaders?: Record<string, string>;
  userAgent?: string;
  /** Policy overrides, or `false` to disable retries entirely. */
  retry?: Partial<RetryPolicy> | false;
  onRetry?: (info: RetryInfo) => void;
  /** Injectable for deterministic jitter. */
  random?: () => number;
  /** Key policy. `true` takes the defaults; omit or `false` to disable. */
  idempotency?: boolean | Partial<IdempotencyConfig>;
  /** Called before each attempt with an already-redacted view. */
  onRequest?: (event: RequestEvent) => void;
  /** Called after each response, error statuses included. */
  onResponse?: (event: ResponseEvent) => void;
  /**
   * Paces requests before they leave. A number is requests per second;
   * pass a shared `TokenBucket` to share a quota across clients.
   */
  rateLimit?: number | RateLimitConfig | TokenBucket | false;
}

export interface RequestOptions {
  query?: QueryInput | null;
  body?: BodyInput;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * `true` retries even a non-idempotent method — the explicit opt-in a POST
   * needs. `false` disables. An object merges into the client policy with the
   * method allowlist still applied.
   */
  retry?: boolean | Partial<RetryPolicy>;
  /**
   * Key for this request. Wins over the policy, and makes the request
   * replay-safe, so a POST becomes retryable.
   */
  idempotencyKey?: string;
}

export interface TerminalResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

export interface BulkRequest extends RequestOptions {
  /** Defaults to GET. */
  method?: string;
  path: string;
}

export declare class TerminalClient {
  constructor(options: TerminalClientOptions);

  /** Send a signed request, retrying transient failures. */
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<TerminalResponse<T>>;

  get<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body?: BodyInput, options?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, body?: BodyInput, options?: RequestOptions): Promise<T>;
  patch<T = unknown>(path: string, body?: BodyInput, options?: RequestOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<T>;

  /** Send many signed requests with bounded concurrency. */
  bulk<T = unknown>(
    requests: BulkRequest[],
    options?: PoolOptions,
  ): Promise<Array<SettledResult<TerminalResponse<T>>>>;

  /** Walk a paginated endpoint, yielding one page at a time. */
  paginate<T = unknown>(
    path: string,
    options?: ClientPaginateOptions,
  ): AsyncGenerator<TerminalResponse<T>, void, undefined>;

  /** The same walk, flattened to individual items. */
  paginateItems<T = unknown>(
    path: string,
    options?: ClientPaginateOptions & { itemsFrom?: (data: any) => T[] },
  ): AsyncGenerator<T, void, undefined>;
}
