/**
 * Tiny dependency-free validator used at every trust boundary (service inputs,
 * repository hydration, JSON payloads).
 *
 * `Validator<T>` is a pure function: it accumulates field issues instead of
 * throwing halfway through, so callers get one complete error report per call.
 */

import { ValidationError, type FieldIssue } from './errors.js';
import { isCurrency, Money, type Currency } from './money.js';
import {
  ACCOUNT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PRODUCT_STATUSES,
  FULFILMENT_STATUSES,
  USER_ROLES,
  type AccountStatus,
  type FulfilmentStatus,
  type OrderStatus,
  type PaymentStatus,
  type ProductStatus,
  type UserRole,
} from './types.js';

export type Validator<T> = (value: unknown) => T;
export type IssueSink = (issue: FieldIssue) => void;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_3166_PATTERN = /^[A-Z]{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKU_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,31}$/;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`, [{ field: label, message: `Expected object, received ${describe(value)}` }]);
  }
  return value as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Combinators                                                                */
/* -------------------------------------------------------------------------- */

export function fail(issues: FieldIssue[], label: string): never {
  throw new ValidationError(`Invalid ${label}`, issues);
}

export function object<T>(label: string, shape: Readonly<Record<string, Validator<unknown>>>): Validator<T> {
  return (value: unknown): T => {
    const issues: FieldIssue[] = [];
    const source = recordValue(value, label, issues);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const fieldValidator: Validator<unknown> | undefined = shape[key];
      if (fieldValidator === undefined) continue;
      try {
        result[key] = fieldValidator(source[key]);
      } catch (error) {
        collectFieldIssues(error, key, issues);
      }
    }
    if (issues.length > 0) fail(issues, label);
    return result as T;
  };
}

function recordValue(value: unknown, label: string, issues: FieldIssue[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ field: label, message: `Expected an object, received ${describe(value)}` });
    return {};
  }
  return value as Record<string, unknown>;
}

function collectFieldIssues(error: unknown, key: string, sink: FieldIssue[]): void {
  if (error instanceof ValidationError) {
    if (error.issues.length > 0) {
      for (const issue of error.issues) sink.push({ field: `${key}.${issue.field}`, message: issue.message });
    } else {
      sink.push({ field: key, message: error.message });
    }
    return;
  }
  if (error instanceof Error) {
    sink.push({ field: key, message: error.message });
    return;
  }
  sink.push({ field: key, message: String(error) });
}

/** Wrap a validator so `undefined` is allowed through untouched. */
export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value: unknown): T | undefined => (value === undefined ? undefined : inner(value));
}

/** Wrap a validator so `null`/`undefined` collapse to `null`. */
export function nullable<T>(inner: Validator<T>): Validator<T | null> {
  return (value: unknown): T | null => (value === null || value === undefined ? null : inner(value));
}

/** Map a successfully parsed value (e.g. lower-casing an e-mail). */
export function map<T, U>(inner: Validator<T>, transform: (value: T) => U): Validator<U> {
  return (value: unknown): U => transform(inner(value));
}

/** Add a cross-field predicate on top of an existing validator. */
export function refine<T>(inner: Validator<T>, predicate: (value: T) => boolean, message: string): Validator<T> {
  return (value: unknown): T => {
    const parsed = inner(value);
    if (!predicate(parsed)) throw new ValidationError(message);
    return parsed;
  };
}

/** Exactly one of the branches must succeed; the first match wins. */
export function union<T>(label: string, branches: readonly Validator<T>[]): Validator<T> {
  return (value: unknown): T => {
    const errors: string[] = [];
    for (const branch of branches) {
      try {
        return branch(value);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new ValidationError(`Invalid ${label}: ${errors.join(' | ')}`);
  };
}

/** Assert a literal discriminator field before validating the rest of an object. */
export function discriminated<T extends Record<string, unknown>>(
  label: string,
  key: keyof T & string,
  variants: Readonly<Record<string, Validator<unknown>>>,
): Validator<T> {
  return (value: unknown): T => {
    const source = asRecord(value, label);
    const discriminator = source[key];
    if (typeof discriminator !== 'string') {
      throw new ValidationError(`${label}.${key} must be a string`, [{ field: `${label}.${key}`, message: 'Missing discriminator' }]);
    }
    const variant: Validator<unknown> | undefined = variants[discriminator];
    if (variant === undefined) {
      throw new ValidationError(
        `Unknown ${label}.${key} '${discriminator}'. Expected one of: ${Object.keys(variants).join(', ')}`,
      );
    }
    return variant(value) as T;
  };
}

export function string(options: { minLength?: number; maxLength?: number; pattern?: RegExp; trim?: boolean } = {}): Validator<string> {
  return (value: unknown): string => {
    if (typeof value !== 'string') throw new ValidationError('Expected a string', [], { received: describe(value) });
    const output = options.trim === false ? value : value.trim();
    if (options.minLength !== undefined && output.length < options.minLength) {
      throw new ValidationError(`Must be at least ${String(options.minLength)} character(s)`, [], { length: output.length });
    }
    if (options.maxLength !== undefined && output.length > options.maxLength) {
      throw new ValidationError(`Must be at most ${String(options.maxLength)} character(s)`, [], { length: output.length });
    }
    if (options.pattern !== undefined && !options.pattern.test(output)) {
      throw new ValidationError(`Does not match the required format ${String(options.pattern)}`);
    }
    return output;
  };
}

export function integer(options: { min?: number; max?: number } = {}): Validator<number> {
  return (value: unknown): number => {
    const numeric = coerceNumber(value);
    if (!Number.isSafeInteger(numeric)) throw new ValidationError(`Must be a whole number, received '${String(value)}'`);
    if (options.min !== undefined && numeric < options.min) {
      throw new ValidationError(`Must be >= ${String(options.min)}, received ${String(numeric)}`);
    }
    if (options.max !== undefined && numeric > options.max) {
      throw new ValidationError(`Must be <= ${String(options.max)}, received ${String(numeric)}`);
    }
    return numeric;
  };
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`Must be a finite number, received '${String(value)}'`);
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ValidationError(`Expected a number, received ${describe(value)}`);
}

export function positiveInteger(min = 1): Validator<number> {
  return integer({ min });
}

export function nonNegativeInteger(): Validator<number> {
  return integer({ min: 0 });
}

export function moneyIn(currency: Currency): Validator<Money> {
  return (value: unknown): Money => {
    if (value instanceof Money) {
      if (value.currency !== currency) {
        throw new ValidationError(`Expected ${currency} but received ${value.currency}`, [
          { field: 'currency', message: `Expected ${currency}` },
        ]);
      }
      return value;
    }
    const record = asRecord(value, 'money');
    const rawCurrency = record['currency'];
    if (!isCurrency(rawCurrency)) throw new ValidationError(`Unsupported currency '${String(rawCurrency)}'`);
    const amount = record['amount'];
    if (typeof amount !== 'number' || !Number.isInteger(amount)) {
      throw new ValidationError('Minor-unit amount must be an integer');
    }
    const money = Money.fromMinor(rawCurrency, amount);
    if (money.currency !== currency) {
      throw new ValidationError(`Expected ${currency} but received ${money.currency}`);
    }
    return money;
  };
}

export function anyMoney(): Validator<Money> {
  return (value: unknown): Money => {
    if (value instanceof Money) return value;
    const record = asRecord(value, 'money');
    const rawCurrency = record['currency'];
    if (!isCurrency(rawCurrency)) throw new ValidationError(`Unsupported currency '${String(rawCurrency)}'`);
    const amount = record['amount'];
    if (typeof amount !== 'number' || !Number.isInteger(amount)) {
      throw new ValidationError('Minor-unit amount must be an integer');
    }
    return Money.fromMinor(rawCurrency, amount);
  };
}

export function enumOf<T extends string>(label: string, allowed: readonly T[]): Validator<T> {
  return (value: unknown): T => {
    if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
    const found: T | undefined = allowed.find((candidate: T) => candidate === (value as T));
    if (found === undefined) {
      throw new ValidationError(`Invalid ${label} '${value}'. Expected one of: ${allowed.join(', ')}`);
    }
    return found;
  };
}

export function array<T>(inner: Validator<T>, options: { min?: number; max?: number } = {}): Validator<T[]> {
  return (value: unknown): T[] => {
    if (!Array.isArray(value)) throw new ValidationError(`Expected an array, received ${describe(value)}`);
    if (options.min !== undefined && value.length < options.min) {
      throw new ValidationError(`Must contain at least ${String(options.min)} item(s)`);
    }
    if (options.max !== undefined && value.length > options.max) {
      throw new ValidationError(`Must contain at most ${String(options.max)} item(s)`);
    }
    const issues: FieldIssue[] = [];
    const out: T[] = [];
    value.forEach((entry: unknown, index: number) => {
      try {
        out.push(inner(entry));
      } catch (error) {
        collectFieldIssues(error, `[${String(index)}]`, issues);
      }
    });
    if (issues.length > 0) fail(issues, 'array');
    return out;
  };
}

export function uniqueBy<T>(inner: Validator<T>, key: (item: T) => string, label = 'items'): Validator<T[]> {
  return (value: unknown): T[] => {
    const items: T[] = array(inner)(value);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const item of items) {
      const id = key(item);
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    if (duplicates.length > 0) {
      throw new ValidationError(`Duplicate ${label}: ${Array.from(new Set(duplicates)).join(', ')}`, [], { duplicates });
    }
    return items;
  };
}

export function recordOfValues(inner: Validator<string>): Validator<Record<string, string>> {
  return (value: unknown): Record<string, string> => {
    const source = asRecord(value, 'attributes');
    const issues: FieldIssue[] = [];
    const out: Record<string, string> = {};
    for (const key of Object.keys(source)) {
      try {
        out[key] = inner(source[key]);
      } catch (error) {
        collectFieldIssues(error, key, issues);
      }
    }
    if (issues.length > 0) fail(issues, 'attributes');
    return out;
  };
}

export function isoDateTime(options: { inPastOnly?: boolean } = {}): Validator<string> {
  return (value: unknown): string => {
    if (typeof value !== 'string') throw new ValidationError('Expected an ISO-8601 timestamp');
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) throw new ValidationError(`Unparseable timestamp '${value}'`);
    if (options.inPastOnly === true && timestamp > Date.now() + 60_000) {
      throw new ValidationError(`Timestamp '${value}' is in the future`);
    }
    return new Date(timestamp).toISOString();
  };
}

export const identifier: Validator<string> = string({ minLength: 1, maxLength: 64 });
export const uuid: Validator<string> = string({ pattern: UUID_PATTERN });
export const slug: Validator<string> = string({ minLength: 3, maxLength: 80, pattern: SLUG_PATTERN });
/** E-mails are trimmed, format-checked and stored lower-cased. */
export const email: Validator<string> = map(
  string({ minLength: 5, maxLength: 254, pattern: EMAIL_PATTERN }),
  (value: string): string => value.toLowerCase(),
);
export const nonEmptyText: Validator<string> = string({ minLength: 1, maxLength: 4_000 });
export const shortText: Validator<string> = string({ minLength: 1, maxLength: 160 });

export const countryCode: Validator<string> = string({ pattern: ISO_3166_PATTERN });
export const skuCode: Validator<string> = string({ pattern: SKU_CODE_PATTERN });
export const currencyCode: Validator<Currency> = (value: unknown): Currency => {
  if (!isCurrency(value)) throw new ValidationError(`Unsupported currency '${String(value)}'`);
  return value;
};

export const role: Validator<UserRole> = enumOf('role', USER_ROLES);
export const accountStatus: Validator<AccountStatus> = enumOf('status', ACCOUNT_STATUSES);
export const productStatus: Validator<ProductStatus> = enumOf('status', PRODUCT_STATUSES);
export const orderStatus: Validator<OrderStatus> = enumOf('status', ORDER_STATUSES);
export const paymentStatus: Validator<PaymentStatus> = enumOf('paymentStatus', PAYMENT_STATUSES);
export const fulfilmentStatus: Validator<FulfilmentStatus> = enumOf('fulfilmentStatus', FULFILMENT_STATUSES);

/** Quantity guard that respects MOQ and pack steps. */
export function quantityRespecting(minOrderQuantity: number, step: number): Validator<number> {
  return (value: unknown): number => {
    const quantity = positiveInteger()(value);
    if (quantity < minOrderQuantity) {
      throw new ValidationError(`Minimum order quantity is ${String(minOrderQuantity)}`, [], {
        minOrderQuantity,
      });
    }
    if (step > 1 && quantity % step !== 0) {
      throw new ValidationError(`Quantity must be a multiple of ${String(step)}`, [], { step });
    }
    return quantity;
  };
}

export { asRecord };
