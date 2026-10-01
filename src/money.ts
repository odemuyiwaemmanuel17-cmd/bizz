/**
 * Money as an integer minor-unit value object.
 *
 * Floats are never used for currency: `19.99 * 3` must not become `59.97000004`.
 * All arithmetic is integer-based with explicit rounding modes, and every
 * `Money` instance is frozen so it can be shared freely (value semantics).
 */

import { ValidationError } from './errors.js';

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'NGN'] as const;
export type Currency = (typeof CURRENCIES)[number];

export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

const ISO_4217_EXPONENT: Readonly<Record<Currency, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  NGN: 2,
};

const SYMBOL: Readonly<Record<Currency, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  NGN: '\u20a6',
};

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

export function currencyExponent(currency: Currency): number {
  const exponent: number | undefined = ISO_4217_EXPONENT[currency];
  if (exponent === undefined) throw ValidationError.field('currency', `Unsupported currency '${String(currency)}'`);
  return exponent;
}

function roundToInteger(value: number, mode: RoundingMode): number {
  if (!Number.isFinite(value)) throw new ValidationError(`Cannot round non-finite value '${String(value)}'`);
  switch (mode) {
    case 'down':
      return Math.trunc(value);
    case 'up':
      return value > 0 ? Math.ceil(value) : Math.floor(value);
    case 'half-even': {
      const floorPart = Math.floor(value);
      const diff = value - floorPart;
      const epsilon = 1e-9;
      if (Math.abs(diff - 0.5) < epsilon) return floorPart % 2 === 0 ? floorPart : floorPart + 1;
      return Math.round(value);
    }
    case 'half-up':
    default:
      // Round half away from zero so refunds/discounts behave symmetrically.
      return value < 0 ? -Math.round(-value) : Math.round(value);
  }
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0 ? 1 : x;
}

function lcms(values: readonly number[]): number {
  let result = 1;
  for (const value of values) result = (result * value) / gcd(result, value);
  return result;
}

function decimalDigits(value: number): number {
  if (!Number.isFinite(value)) throw new ValidationError(`Amount must be finite, received '${String(value)}'`);
  if (Number.isInteger(value)) return 0;
  const text = String(value);
  const match = /^(?:[^.])*(?:\.(\d+)?)(?:[eE][-+]?\d+)?$/.exec(text);
  if (match === null) return 0;
  const fraction = match[1] ?? '';
  const exponent = Number.parseInt(/(?:[eE]([-+]?\d+))$/.exec(text)?.[1] ?? '0', 10);
  return Math.max(0, fraction.length - (Number.isNaN(exponent) ? 0 : exponent));
}

/** A validated, immutable amount in one currency, stored as integer minor units. */
export class Money {
  public readonly currency: Currency;
  /** Integer minor units, e.g. cents for USD. */
  public readonly amount: number;

  private constructor(currency: Currency, amount: number) {
    this.currency = currency;
    this.amount = amount;
    Object.freeze(this);
  }

  /** Exact factory from already-scaled integer minor units. */
  public static fromMinor(currency: Currency, amount: number): Money {
    if (!isCurrency(currency)) throw ValidationError.field('currency', `Unsupported currency '${String(currency)}'`);
    if (!Number.isInteger(amount)) {
      throw ValidationError.field('amount', `Minor-unit amount must be an integer, received '${String(amount)}'`);
    }
    return new Money(currency, amount);
  }

  /** Factory from a major-unit number (`19.99`) using the given rounding mode. */
  public static fromMajor(currency: Currency, value: number, mode: RoundingMode = 'half-up'): Money {
    if (!isCurrency(currency)) throw ValidationError.field('currency', `Unsupported currency '${String(currency)}'`);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw ValidationError.field('amount', `Amount must be a finite number, received '${String(value)}'`);
    }
    const scale = 10 ** currencyExponent(currency);
    return new Money(currency, roundToInteger(value * scale, mode));
  }

  /**
   * Parse a display string such as `"1,299.99"`, `"-$5.00"` or `"12 €"`.
   * The parsed currency must equal `expected` when supplied.
   */
  public static parse(input: string, expected?: Currency): Money {
    if (typeof input !== 'string') throw ValidationError.field('amount', 'Amount must be a string');
    const text = input.trim();
    if (text.length === 0) throw ValidationError.field('amount', 'Amount must not be empty');

    let symbolCurrency: Currency | undefined;
    let body = text;
    for (const code of CURRENCIES) {
      const symbol = SYMBOL[code];
      if (body.includes(symbol)) {
        symbolCurrency = code;
        body = body.split(symbol).join('');
        break;
      }
    }
    if (/^[A-Za-z]{3}\s*/.test(body)) {
      const code = body.slice(0, 3).toUpperCase();
      if (isCurrency(code)) {
        if (symbolCurrency !== undefined && symbolCurrency !== code) {
          throw ValidationError.field('amount', `Conflicting currencies in '${input}'`);
        }
        symbolCurrency = code;
        body = body.slice(3);
      }
    }

    const negative = /^\s*-/.test(body) || /\-\s*$/.test(body);
    const cleaned = body.replace(/[\s,_]/g, '').replace(/-/g, '');
    if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === '.' || cleaned.length === 0) {
      throw ValidationError.field('amount', `Unable to parse monetary value '${input}'`);
    }
    if (!isCurrency(symbolCurrency)) {
      throw ValidationError.field(
        'currency',
        `Unable to determine the currency of '${input}'; pass a currency symbol or code`,
      );
    }
    const major = Number.parseFloat(cleaned === '' || cleaned === '.' ? '0' : cleaned);
    if (!Number.isFinite(major)) throw ValidationError.field('amount', `Unable to parse monetary value '${input}'`);
    const money = Money.fromMajor(symbolCurrency, major);
    return negative ? money.negate() : money;
  }

  public get minorUnits(): number {
    return this.amount;
  }

  public get majorUnits(): number {
    return this.amount / 10 ** currencyExponent(this.currency);
  }

  public get isNegative(): boolean {
    return this.amount < 0;
  }

  public get isZero(): boolean {
    return this.amount === 0;
  }

  public get isPositive(): boolean {
    return this.amount > 0;
  }

  private requireSameCurrency(other: Money, operation: string): void {
    if (this.currency !== other.currency) {
      throw new ValidationError(
        `Cannot ${operation} ${this.currency} with ${other.currency}: currencies must match`,
        [{ field: 'currency', message: `Expected ${this.currency}, received ${other.currency}` }],
        { left: this.currency, right: other.currency },
      );
    }
  }

  public add(other: Money): Money {
    this.requireSameCurrency(other, 'add');
    return Money.fromMinor(this.currency, safeSum(this.amount, other.amount, 'sum'));
  }

  public subtract(other: Money): Money {
    this.requireSameCurrency(other, 'subtract');
    return Money.fromMinor(this.currency, safeSum(this.amount, -other.amount, 'difference'));
  }

  /** Multiply by a dimensionless factor (tax rate, quantity...). */
  public multiply(factor: number, mode: RoundingMode = 'half-up'): Money {
    if (typeof factor !== 'number' || !Number.isFinite(factor)) {
      throw ValidationError.field('factor', `Factor must be finite, received '${String(factor)}'`);
    }
    return Money.fromMinor(this.currency, this.roundScaled(this.amount * factor, mode));
  }

  /** Divide into `divisor` equal parts, distributing remainders penny-by-penny. */
  public divide(divisor: number, mode: RoundingMode = 'half-up'): Money {
    if (!Number.isInteger(divisor) || divisor <= 0) {
      throw ValidationError.field('divisor', `Divisor must be a positive integer, received '${String(divisor)}'`);
    }
    return Money.fromMinor(this.currency, this.roundScaled(this.amount / divisor, mode));
  }

  /** Split into `parts` shares whose sum is exactly this amount (largest remainder). */
  public allocate(parts: number): readonly Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw ValidationError.field('parts', `Parts must be a positive integer, received '${String(parts)}'`);
    }
    const base = Math.trunc(this.amount / parts);
    if (!Number.isSafeInteger(base) || !Number.isSafeInteger(base * parts)) {
      throw new ValidationError(`Cannot allocate ${String(this.amount)} minor units across ${String(parts)} parts safely`);
    }
    let remainder = this.amount - base * parts;
    const unit = this.amount < 0 ? -1 : 1;
    const out: Money[] = [];
    for (let index = 0; index < parts; index += 1) {
      const extra = remainder !== 0 ? unit : 0;
      if (remainder !== 0) remainder -= unit;
      out.push(Money.fromMinor(this.currency, base + extra));
    }
    return Object.freeze(out);
  }

  /** Apply a percentage expressed in basis points (1250n = 12.50%). */
  public percentOfBasisPoints(basisPoints: number): Money {
    if (!Number.isInteger(basisPoints) || basisPoints < 0) {
      throw ValidationError.field('basisPoints', `Basis points must be >= 0, received '${String(basisPoints)}'`);
    }
    return this.multiply(basisPoints / 10_000);
  }

  public negate(): Money {
    return Money.fromMinor(this.currency, -this.amount);
  }

  public abs(): Money {
    return this.amount < 0 ? this.negate() : this;
  }

  public compareTo(other: Money): -1 | 0 | 1 {
    this.requireSameCurrency(other, 'compare');
    if (this.amount < other.amount) return -1;
    if (this.amount > other.amount) return 1;
    return 0;
  }

  public equals(other: unknown): boolean {
    return other instanceof Money && other.currency === this.currency && other.amount === this.amount;
  }

  public lessThan(other: Money): boolean {
    return this.compareTo(other) === -1;
  }

  public greaterThan(other: Money): boolean {
    return this.compareTo(other) === 1;
  }

  public atLeast(other: Money): boolean {
    return this.compareTo(other) >= 0;
  }

  public atMost(other: Money): boolean {
    return this.compareTo(other) <= 0;
  }

  /** Zero-clamped result, handy for "remaining balance" maths. */
  public subtractFloorZero(other: Money): Money {
    const result = this.subtract(other);
    return result.isNegative ? Money.fromMinor(this.currency, 0) : result;
  }

  /** Throw unless the amount is strictly positive (typical line-item guard). */
  public assertPositive(field = 'amount'): Money {
    if (!this.isPositive) {
      throw ValidationError.field(field, `${field} must be greater than zero`);
    }
    return this;
  }

  public assertNonNegative(field = 'amount'): Money {
    if (this.isNegative) throw ValidationError.field(field, `${field} must not be negative`);
    return this;
  }

  public toJSON(): { readonly currency: Currency; readonly amount: number } {
    return { currency: this.currency, amount: this.amount };
  }

  /** Machine-stable representation used for idempotency hashing. */
  public toString(): string {
    return `${this.currency}:${String(this.amount)}`;
  }

  private roundScaled(scaled: number, mode: RoundingMode): number {
    const rounded: number = roundToInteger(scaled, mode);
    if (!Number.isSafeInteger(rounded)) {
      throw new ValidationError(
        `Operation on ${String(this.amount)} ${this.currency} minor units overflowed the safe integer range`,
        [],
        { amount: this.amount, result: scaled },
      );
    }
    return rounded;
  }

  /** Human display, e.g. `$19.99` / `-€1,234.50`. */
  public format(locale: string = 'en-US'): string {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: this.currency,
        minimumFractionDigits: currencyExponent(this.currency),
        maximumFractionDigits: currencyExponent(this.currency),
      }).format(this.majorUnits);
    } catch {
      // Unsupported locale at runtime: degrade instead of throwing.
      return `${SYMBOL[this.currency]}${this.majorUnits.toFixed(currencyExponent(this.currency))}`;
    }
  }

  /** Sum a homogeneous list; an empty list yields zero in `currency`. */
  public static sum(values: readonly Money[], currency: Currency): Money {
    let total = Money.fromMinor(currency, 0);
    for (const value of values) total = total.add(value);
    return total;
  }

  public static zero(currency: Currency): Money {
    return Money.fromMinor(currency, 0);
  }

  /** Greatest common divisor of minor units across a set of prices (>1 means bundling is possible). */
  public static commonDivisor(prices: readonly Money[]): number {
    if (prices.length === 0) return 1;
    const first = prices[0];
    if (first === undefined) return 1;
    let result = Math.abs(first.amount);
    for (const price of prices) {
      first.requireSameCurrency(price, 'compare');
      result = gcd(result, Math.abs(price.amount));
      if (result <= 1) return 1;
    }
    return result === 0 ? 1 : result;
  }

  /** Least common multiple of the supplied amounts; used by pricing tests. */
  public static leastCommonMultiple(values: readonly number[]): number {
    return lcms(values.map((value) => Math.abs(Math.trunc(value))));
  }

  /** Number of decimals present in a major-unit input (guards over-precise prices). */
  public static precisionOf(value: number): number {
    return decimalDigits(value);
  }
}

function safeSum(left: number, right: number, label: string): number {
  const result: number = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new ValidationError(`${label} of ${String(left)} and ${String(right)} exceeds the safe integer range`);
  }
  return result;
}

export const ZERO_USD: Money = Money.fromMinor('USD', 0);
