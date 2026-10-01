/**
 * Node's built-in test runner (`node:test`) is used instead of Jest/Vitest so the
 * package stays dependency-free and runs on any Node >= 20.11 install.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Money } from '../../src/money.js';
import { ValidationError, BizzError, toBizzError, isBizzError } from '../../src/errors.js';

test('Money.fromMajor rounds half-up into minor units', () => {
  assert.equal(Money.fromMajor('USD', 19.99).minorUnits, 1999);
  assert.equal(Money.fromMajor('USD', 0.005).minorUnits, 1);
  assert.equal(Money.fromMajor('USD', -19.994).minorUnits, -1999);
});

test('Money arithmetic keeps currency discipline', () => {
  const a = Money.fromMinor('USD', 1000);
  const b = Money.fromMinor('USD', 350);
  assert.equal(a.add(b).minorUnits, 1350);
  assert.equal(a.subtract(b).minorUnits, 650);
  assert.equal(a.multiply(3).minorUnits, 3000);
  assert.equal(a.divide(4).minorUnits, 250);
  assert.throws(() => a.add(Money.fromMinor('EUR', 1)), (error: unknown) => error instanceof ValidationError && error.code === 'VALIDATION');
});

test('Money.allocate never loses or invents pennies', () => {
  const total = Money.fromMinor('USD', 1000);
  const parts = total.allocate(3);
  assert.deepEqual(parts.map((part: Money) => part.minorUnits), [334, 333, 333]);
  assert.equal(Money.sum(parts, 'USD').minorUnits, 1000);

  const negative = Money.fromMinor('USD', -10).allocate(3);
  assert.equal(Money.sum(negative, 'USD').minorUnits, -10);

  assert.throws(() => total.allocate(0), ValidationError);
  assert.throws(() => total.allocate(1.5), ValidationError);
});

test('Money.parse understands symbols, codes and negatives', () => {
  assert.equal(Money.parse('$1,299.99').minorUnits, 129999);
  assert.equal(Money.parse('-$5.00').minorUnits, -500);
  assert.equal(Money.parse('12 €').currency, 'EUR');
  assert.equal(Money.parse('NGN 2500.50').minorUnits, 250050);
  assert.throws(() => Money.parse('not money'), ValidationError);
  assert.throws(() => Money.parse(''), ValidationError);
  assert.throws(() => Money.parse('12.34'), ValidationError); // no currency present
});

test('Money instances are immutable value objects', () => {
  const amount = Money.fromMinor('GBP', 500);
  assert.ok(Object.isFrozen(amount));
  assert.equal(amount.equals(Money.fromMinor('GBP', 500)), true);
  assert.equal(amount.equals(Money.fromMinor('GBP', 501)), false);
  assert.equal(amount.toString(), 'GBP:500');
  assert.deepEqual(JSON.parse(JSON.stringify(amount)), { currency: 'GBP', amount: 500 });
});

test('Money rejects nonsense input rather than coercing silently', () => {
  assert.throws(() => Money.fromMinor('USD', 10.5), ValidationError);
  assert.throws(() => Money.fromMajor('USD', Number.NaN), ValidationError);
  assert.throws(() => Money.fromMajor('USD', Number.POSITIVE_INFINITY), ValidationError);
  assert.throws(() => Money.fromMinor('XXX' as never, 1), ValidationError);
  // Sums that would exceed 2^53 are rejected instead of drifting silently.
  assert.throws(() => Money.fromMajor('USD', Number.MAX_SAFE_INTEGER / 4), ValidationError);
});

test('percentOfBasisPoints and sum helpers', () => {
  assert.equal(Money.fromMinor('USD', 20000).percentOfBasisPoints(1250).minorUnits, 2500);
  assert.equal(Money.sum([Money.fromMinor('EUR', 100), Money.fromMinor('EUR', 250)], 'EUR').minorUnits, 350);
  assert.equal(Money.sum([], 'USD').minorUnits, 0);
  assert.equal(Money.zero('NGN').majorUnits, 0);
});

test('comparison and clamping helpers', () => {
  const ten = Money.fromMinor('USD', 1000);
  assert.equal(ten.lessThan(Money.fromMinor('USD', 1001)), true);
  assert.equal(ten.greaterThan(Money.fromMinor('USD', 999)), true);
  assert.equal(ten.atLeast(ten), true);
  assert.equal(ten.compareTo(ten), 0);
  assert.equal(ten.subtractFloorZero(Money.fromMinor('USD', 4000)).minorUnits, 0);
  assert.equal(ten.negate().abs().minorUnits, 1000);
  assert.throws(() => ten.assertPositive(), ValidationError);
  assert.equal(Money.fromMinor('USD', 1).assertPositive().minorUnits, 1);
});

test('format uses Intl and degrades gracefully for odd locales', () => {
  assert.equal(Money.fromMinor('USD', 123456).format('en-US'), '$1,234.56');
  assert.equal(Money.fromMinor('USD', -500).format('en-US'), '-$5.00');
});

test('toBizzError normalizes foreign throws without losing the cause', () => {
  const normalized = toBizzError(new Error('db down'));
  assert.ok(isBizzError(normalized));
  assert.equal(normalized.code, 'INTERNAL');
  assert.match(normalized.message, /db down/);
  const original = new ValidationError('nope', [{ field: 'email', message: 'bad' }]);
  assert.equal(toBizzError(original), original);
  assert.equal(toBizzError(null).code, 'INTERNAL');
  assert.ok(BizzError.prototype instanceof Error);
});

test('ValidationError reports per-field issues', () => {
  const error = new ValidationError('Invalid product', [
    { field: 'title', message: 'too short' },
    { field: 'price', message: 'must be positive' },
    { field: 'title', message: 'ignored duplicate' },
  ]);
  assert.equal(error.hasIssues, true);
  assert.deepEqual(error.issueMap(), { title: 'too short', price: 'must be positive' });
  assert.equal(error.toJSON().code, 'VALIDATION');
});
