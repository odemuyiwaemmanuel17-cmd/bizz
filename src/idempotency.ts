/**
 * Request-level idempotency (Stripe-style) for money-moving endpoints.
 *
 * Flow: `begin(key, payload)` -> run the handler -> `complete(result)`; failures
 * call `fail()` so a retry can re-execute instead of being stuck behind a broken
 * attempt. Replays return the stored result byte-for-byte; re-using a key with a
 * different payload is rejected rather than silently ignored.
 */

import { ConflictError, DuplicateRequestError, InternalError, ValidationError } from './errors.js';
import type { Clock } from './id.js';

export type IdempotencyState = 'in_progress' | 'succeeded' | 'failed';

export interface StoredResult<TResponse> {
  readonly key: string;
  readonly fingerprint: string;
  readonly state: IdempotencyState;
  readonly response?: TResponse;
  readonly error?: { readonly code: string; readonly message: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: number;
}

export interface BeginResult<TResponse> {
  readonly replayed: boolean;
  readonly record: StoredResult<TResponse>;
}

export interface IdempotencyStore {
  get<T>(key: string): Promise<StoredResult<T> | undefined>;
  put<T>(record: StoredResult<T>): Promise<StoredResult<T>>;
  delete(key: string): Promise<void>;
}

export interface IdempotencyOptions {
  /** Records older than this are treated as absent so keys can be recycled. */
  readonly ttlMs?: number;
  /** In-flight attempts older than this are considered abandoned and retried. */
  readonly staleAfterMs?: number;
  readonly now?: () => Date;
}

/** Process-local store; swap for Redis/DynamoDB in production. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records: Map<string, StoredResult<unknown>> = new Map();

  public async get<T>(key: string): Promise<StoredResult<T> | undefined> {
    const found: StoredResult<unknown> | undefined = this.records.get(key);
    return found === undefined ? undefined : (found as StoredResult<T>);
  }

  public async put<T>(record: StoredResult<T>): Promise<StoredResult<T>> {
    this.records.set(record.key, record as StoredResult<unknown>);
    return record;
  }

  public async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  public get size(): number {
    return this.records.size;
  }
}

/** FNV-1a over a canonical JSON projection — stable across key ordering. */
export function canonicalFingerprint(payload: unknown): string {
  return fnv1aHex(canonicalize(payload, 0));
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function canonicalize(value: unknown, depth: number): string {
  if (depth > 24) return '"<max-depth>"';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'bigint':
      return `"${String(value)}"`;
    case 'string':
      return JSON.stringify(value);
    default:
      break;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((entry: unknown) => canonicalize(entry, depth + 1)).join(',')}]`;
  if (value instanceof Map) {
    const entries: [string, unknown][] = [...value.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return `{${entries.map(([k, v]: [string, unknown]) => `${JSON.stringify(k)}:${canonicalize(v, depth + 1)}`).join(',')}}`;
  }
  if (value instanceof Set) {
    const items: unknown[] = [...value];
    return `[${items.map((entry: unknown) => canonicalize(entry, depth + 1)).sort().join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys: string[] = Object.keys(record).sort();
    return `{${keys.map((key: string) => `${JSON.stringify(key)}:${canonicalize(record[key], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export class IdempotencyGuard<TPayload, TResponse> {
  private readonly store: IdempotencyStore;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly staleAfterMs: number;

  public constructor(store: IdempotencyStore, clock: Clock, options: IdempotencyOptions = {}) {
    if (store === undefined) throw ValidationError.field('store', 'An idempotency store is required');
    if (clock === undefined) throw ValidationError.field('clock', 'A clock is required');
    this.store = store;
    this.clock = options.now !== undefined ? { now: options.now } : clock;
    this.ttlMs = positiveOr(options.ttlMs ?? 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
    this.staleAfterMs = positiveOr(options.staleAfterMs ?? 5 * 60 * 1000, 5 * 60 * 1000);
  }

  public validateKey(key: unknown): string {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw ValidationError.field('idempotencyKey', 'Idempotency keys must be 8-128 URL-safe characters');
    }
    return key;
  }

  /** Look up an existing record, honouring TTL and stale in-flight attempts. */
  public async inspect(key: unknown, payload: TPayload): Promise<{ readonly record: StoredResult<TResponse> | undefined; readonly fingerprint: string }> {
    const validated: string = this.validateKey(key);
    const fingerprint: string = canonicalFingerprint(payload);
    const record: StoredResult<TResponse> | undefined = await this.store.get<TResponse>(validated);
    if (record === undefined) return { record: undefined, fingerprint };

    const age: number = this.clock.now().getTime() - Date.parse(record.updatedAt);
    if (Number.isFinite(age) && age > this.ttlMs) {
      await this.store.delete(validated);
      return { record: undefined, fingerprint };
    }
    if (record.state === 'in_progress' && Number.isFinite(age) && age > this.staleAfterMs) {
      // The previous worker died; allow a fresh attempt.
      await this.store.delete(validated);
      return { record: undefined, fingerprint };
    }
    return { record, fingerprint };
  }

  /** Claim the key. Throws when another request already owns it. */
  public async begin(key: unknown, payload: TPayload): Promise<BeginResult<TResponse>> {
    const { record, fingerprint } = await this.inspect(key, payload);
    const validated: string = this.validateKey(key);
    const now: string = this.clock.now().toISOString();

    if (record !== undefined) {
      if (record.fingerprint !== fingerprint) throw new DuplicateRequestError(validated, true);
      if (record.state === 'succeeded') return { replayed: true, record };
      if (record.state === 'in_progress') throw new DuplicateRequestError(validated, false);
      // Previously failed: retry by adopting the same row and bumping attempts.
      const retry: StoredResult<TResponse> = Object.freeze({
        ...record,
        state: 'in_progress',
        error: undefined,
        updatedAt: now,
        attempts: record.attempts + 1,
      });
      return { replayed: false, record: await this.store.put(retry) };
    }

    const fresh: StoredResult<TResponse> = Object.freeze({
      key: validated,
      fingerprint,
      state: 'in_progress',
      createdAt: now,
      updatedAt: now,
      attempts: 1,
    });
    return { replayed: false, record: await this.store.put(fresh) };
  }

  public async complete(record: StoredResult<TResponse>, response: TResponse): Promise<StoredResult<TResponse>> {
    const done: StoredResult<TResponse> = Object.freeze({
      ...record,
      state: 'succeeded',
      response,
      error: undefined,
      updatedAt: this.clock.now().toISOString(),
    });
    return await this.store.put(done);
  }

  public async fail(record: StoredResult<TResponse>, error: unknown): Promise<StoredResult<TResponse>> {
    const described: { code: string; message: string } =
      error instanceof ValidationError
        ? { code: error.code, message: error.message }
        : error instanceof Error
          ? { code: 'INTERNAL', message: error.message }
          : { code: 'INTERNAL', message: String(error) };
    const failed: StoredResult<TResponse> = Object.freeze({
      ...record,
      state: 'failed',
      error: described,
      updatedAt: this.clock.now().toISOString(),
    });
    return await this.store.put(failed);
  }

  /**
   * Run `handler` exactly once per (key, payload) pair. Concurrency-safe under a
   * shared store that provides atomic `put`; with the in-memory store the JS
   * single-threaded event loop already serialises `begin`.
   */
  public async run(key: unknown, payload: TPayload, handler: (payload: TPayload) => Promise<TResponse>): Promise<TResponse> {
    const claim = await this.begin(key, payload);
    if (claim.replayed) {
      const stored: StoredResult<TResponse> = claim.record;
      if (stored.response !== undefined) return stored.response;
      if (stored.error !== undefined) {
        throw new ConflictError(`Replaying a previously failed request '${stored.key}'`, { ...stored.error });
      }
      throw new InternalError(`Idempotency record '${stored.key}' is in an unusable state`);
    }
    try {
      const response: TResponse = await handler(payload);
      await this.complete(claim.record, response);
      return response;
    } catch (error) {
      await this.fail(claim.record, error);
      throw error;
    }
  }

  public async release(key: unknown): Promise<void> {
    await this.store.delete(this.validateKey(key));
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
