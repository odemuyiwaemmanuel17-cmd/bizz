/**
 * Deterministic, dependency-free ID generation.
 *
 * Production deployments should inject a UUIDv7 / KSUID generator; the default
 * implementation is seeded so unit tests and snapshot fixtures stay stable.
 */

import { ValidationError } from './errors.js';

export type IdPrefix = 'usr' | 'adr' | 'prd' | 'sku' | 'stk' | 'cat' | 'crt' | 'ord' | 'pay' | 'idk' | 'cpn';

const BASE32_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no I/L/O/U.
const DEFAULT_LENGTH = 10;

/** FNV-1a (32-bit) — enough entropy for collision-resistant test fixtures. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function encodeBase32(value: number, length: number): string {
  let remaining = value >>> 0;
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output = BASE32_ALPHABET[remaining % 32] + output;
    remaining = Math.floor(remaining / 32);
  }
  return output;
}

/**
 * A counter-backed generator: `next()` is pure given the seed, and successive
 * calls never repeat because the internal counter participates in the hash.
 */
export class SequentialIdGenerator {
  private readonly seed: string;
  private counter: number;

  constructor(seed: string = 'bizz', startCounter: number = 0) {
    if (typeof seed !== 'string' || seed.trim().length === 0) {
      throw ValidationError.field('seed', 'Seed must be a non-empty string');
    }
    this.seed = seed;
    this.counter = Number.isSafeInteger(startCounter) ? startCounter : 0;
  }

  /** Peek at the id that would be produced next without advancing state. */
  public peek(prefix: IdPrefix, length: number = DEFAULT_LENGTH): string {
    return this.render(prefix, this.counter, length);
  }

  public next(prefix: IdPrefix, length: number = DEFAULT_LENGTH): string {
    const id = this.render(prefix, this.counter, length);
    this.counter += 1;
    return id;
  }

  /** Reset to a known state (used by fixtures). */
  public reset(counter: number = 0): void {
    this.counter = Number.isSafeInteger(counter) && counter >= 0 ? counter : 0;
  }

  private render(prefix: IdPrefix, counter: number, length: number): string {
    if (length < 4 || length > 26) throw new ValidationError(`ID length must be between 4 and 26, received ${String(length)}`);
    const mixed = fnv1a(`${this.seed}|${prefix}|${String(counter)}`);
    const extra = fnv1a(`${mixed}:${this.seed}:${String(counter)}:${prefix}`);
    const body = (encodeBase32(mixed, Math.min(length, 7)) + encodeBase32(extra, length)).slice(0, length);
    return `${prefix}_${body}`;
  }
}

export interface Clock {
  now(): Date;
}

/** Real wall clock. */
export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

/** Fixed clock for deterministic tests; can be advanced explicitly. */
export class FrozenClock implements Clock {
  private instant: number;

  constructor(iso: string | number = '2026-01-01T00:00:00.000Z') {
    const parsed = typeof iso === 'number' ? iso : Date.parse(iso);
    if (!Number.isFinite(parsed)) throw new ValidationError(`Unparseable clock instant '${String(iso)}'`);
    this.instant = parsed;
  }

  public now(): Date {
    return new Date(this.instant);
  }

  public nowIso(): string {
    return new Date(this.instant).toISOString();
  }

  public advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) throw new ValidationError('Advance amount must be finite');
    this.instant += milliseconds;
  }
}

/** Human-facing order numbers, e.g. `BIZ-20260718-000042`. */
export class OrderNumberGenerator {
  private readonly prefix: string;
  private sequence: number;
  private lastDay: string;
  private readonly clock: Clock;

  constructor(clock: Clock = new SystemClock(), prefix: string = 'BIZ', startSequence: number = 0) {
    if (!/^[A-Z]{2,6}$/.test(prefix)) throw new ValidationError(`Order prefix must be 2-6 upper-case letters, received '${prefix}'`);
    this.clock = clock;
    this.prefix = prefix;
    this.sequence = startSequence;
    this.lastDay = this.day();
  }

  private day(): string {
    return this.clock.now().toISOString().slice(0, 10).replace(/-/g, '');
  }

  public next(): string {
    const today = this.day();
    if (today !== this.lastDay) {
      this.lastDay = today;
      this.sequence = 0;
    }
    this.sequence += 1;
    if (this.sequence > 999_999) throw new ValidationError(`Daily order sequence exhausted for ${today}`);
    return `${this.prefix}-${today}-${this.sequence.toString().padStart(6, '0')}`;
  }
}
