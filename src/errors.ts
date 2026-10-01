/**
 * Error taxonomy for the Bizz marketplace core.
 *
 * Every failure surfaced by the library is a `BizzError` carrying a stable,
 * machine-readable `code`, so callers can branch on semantics instead of on
 * human-readable message text (which is free to change).
 */

export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'INSUFFICIENT_STOCK',
  'INVALID_STATE',
  'UNAUTHORIZED',
  'DUPLICATE_REQUEST',
  'STALE_VERSION',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

/** Options accepted by `BizzError`. */
export interface BizzErrorOptions {
  /** Extra structured data (ids, versions, limits...). Never contains secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Per-field validation problems. */
  readonly issues?: readonly FieldIssue[];
  /** The throwable that caused this error, when wrapping another layer. */
  readonly cause?: unknown;
}

/** Base class for every error thrown by this package. */
export class BizzError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;
  public readonly issues: readonly FieldIssue[];
  public override readonly cause: unknown;

  constructor(code: ErrorCode, message: string, options: BizzErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.issues = Object.freeze([...(options.issues ?? [])]);
    this.cause = options.cause;
    // Keep `instanceof` working if the bundle is down-levelled to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }

  /** True when this error carries field-level detail. */
  public get hasIssues(): boolean {
    return this.issues.length > 0;
  }

  /** Flatten field issues into a `field -> message` map (first issue wins). */
  public issueMap(): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const issue of this.issues) {
      if (!(issue.field in out)) out[issue.field] = issue.message;
    }
    return Object.freeze(out);
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      issues: this.issues,
      details: this.details,
    };
  }
}

export class ValidationError extends BizzError {
  constructor(message: string, issues: readonly FieldIssue[] = [], details?: Record<string, unknown>) {
    super('VALIDATION', message, { issues, details });
  }

  public static field(field: string, message: string): ValidationError {
    return new ValidationError(message, [{ field, message }]);
  }
}

export class NotFoundError extends BizzError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} '${id}' was not found`, { details: { entity, id } });
  }
}

export class ConflictError extends BizzError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, { details });
  }
}

export class PreconditionFailedError extends BizzError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('PRECONDITION_FAILED', message, { details });
  }
}

/** Optimistic-lock failure: the row changed underneath the caller. */
export class StaleVersionError extends BizzError {
  public readonly expectedVersion: number;
  public readonly actualVersion: number;

  constructor(entity: string, id: string, expectedVersion: number, actualVersion: number) {
    super(
      'STALE_VERSION',
      `${entity} '${id}' changed concurrently (expected v${String(expectedVersion)}, found v${String(actualVersion)})`,
      { details: { entity, id, expectedVersion, actualVersion } },
    );
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class InsufficientStockError extends BizzError {
  public readonly skuId: string;
  public readonly requested: number;
  public readonly available: number;

  constructor(skuId: string, requested: number, available: number) {
    super(
      'INSUFFICIENT_STOCK',
      `Insufficient stock for SKU '${skuId}': requested ${String(requested)}, available ${String(available)}`,
      { details: { skuId, requested, available } },
    );
    this.skuId = skuId;
    this.requested = requested;
    this.available = available;
  }
}

/** Illegal transition in a state machine (order lifecycle, payment flow...). */
export class InvalidStateError extends BizzError {
  public readonly entity: string;
  public readonly from: string;
  public readonly to: string;

  constructor(entity: string, from: string, to: string, reason?: string) {
    super(
      'INVALID_STATE',
      `Cannot move ${entity} from '${from}' to '${to}'${reason === undefined ? '' : `: ${reason}`}`,
      { details: { entity, from, to, reason } },
    );
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export class UnauthorizedError extends BizzError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('UNAUTHORIZED', message, { details });
  }
}

/** Raised when a retried request re-uses an idempotency key with different input. */
export class DuplicateRequestError extends BizzError {
  constructor(key: string, mismatch: boolean) {
    super(
      'DUPLICATE_REQUEST',
      mismatch
        ? `Idempotency key '${key}' was already used with a different payload`
        : `Idempotency key '${key}' is already being processed`,
      { details: { key, mismatch } },
    );
  }
}

export class InternalError extends BizzError {
  constructor(message: string, cause?: unknown) {
    super('INTERNAL', message, { cause });
  }
}

/** Type guard usable across module boundaries / after serialization hops. */
export function isBizzError(value: unknown): value is BizzError {
  return value instanceof BizzError;
}

/** Normalize anything thrown into a `BizzError` without losing information. */
export function toBizzError(value: unknown, fallbackMessage = 'Unexpected failure'): BizzError {
  if (isBizzError(value)) return value;
  if (value instanceof Error) return new InternalError(`${fallbackMessage}: ${value.message}`, value);
  return new InternalError(`${fallbackMessage}: ${String(value)}`, value);
}
