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
}
