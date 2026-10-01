import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anyMoney,
  array,
  discriminated,
  email,
  enumOf,
  integer,
  map,
  moneyIn,
  optional,
  positiveInteger,
  quantityRespecting,
  recordOfValues,
  refine,
  slug,
  skuCode,
  string,
  union,
  uniqueBy,
} from '../../src/schema.js';
import { ValidationError } from '../../src/errors.js';
import { Money } from '../../src/money.js';

/** Validators are generic; `.currency`/`.amount` reads below assert the parsed Money. */
type MoneyValidator = (value: unknown) => Money & Record<string, number>;

test('string validator trims and enforces length', () => {
  assert.equal(string({ minLength: 2, maxLength: 5 })('  abc  '), 'abc');
  assert.throws(() => string({ minLength: 2 })('a'), ValidationError);
  assert.throws(() => string()(42), ValidationError, 'non-string input is rejected');
});

test('integer / positiveInteger bounds', () => {
  assert.equal(integer({ min: 0, max: 10 })(7), 7);
  assert.equal(positiveInteger()(42), 42);
  assert.throws(() => positiveInteger()(0), ValidationError);
  assert.throws(() => integer()(-1.5), ValidationError);
  assert.throws(() => integer()('abc'), ValidationError);
  assert.equal(integer()('12'), 12, 'numeric strings are accepted deliberately');
});

test('email is lower-cased and format-checked', () => {
  assert.equal(email(' Buyer@Example.COM '), 'buyer@example.com');
  for (const bad of ['', 'no-at-sign', 'a@b', 'a b@c.com', 'x@y.z']) {
    assert.throws(() => email(bad), ValidationError, `'${bad}' should not parse`);
  }
});

test('slug and skuCode patterns', () => {
  assert.equal(slug('steel-watering-can'), 'steel-watering-can');
  assert.throws(() => slug('Bad Slug!'), ValidationError);
  assert.equal(skuCode('WC-500-BLK'), 'WC-500-BLK');
  assert.throws(() => skuCode('wc'), ValidationError);
});

test('enumOf produces a readable message', () => {
  const role = enumOf('role', ['buyer', 'seller'] as const);
  assert.equal(role('seller'), 'seller');
  assert.throws(() => role('ghost'), (error: unknown) => {
    return error instanceof ValidationError && /Expected one of: buyer, seller/.test(error.message);
  });
});

test('array collects indexed issues instead of throwing on the first item', () => {
  const validate = array(positiveInteger());
  assert.deepEqual(validate([1, 2, 3]), [1, 2, 3]);
  assert.throws(() => validate([1, -1, 'x']), (error: unknown) => {
    if (!(error instanceof ValidationError)) return false;
    const fields = error.issues.map((issue) => issue.field);
    return fields.includes('[1].quantity') || fields.some((field) => field.startsWith('[1]'));
  });
  assert.throws(() => validate('nope'), ValidationError);
});

test('uniqueBy rejects duplicate keys', () => {
  const validate = uniqueBy(objectish(), (item: { id: string }) => item.id, 'lines');
  assert.doesNotThrow(() => validate([{ id: 'a' }, { id: 'b' }]));
  assert.throws(() => validate([{ id: 'a' }, { id: 'a' }]), ValidationError);
});

function objectish(): (value: unknown) => { id: string } {
  return (value: unknown): { id: string } => {
    const record = value as Record<string, unknown>;
    if (typeof record?.id !== 'string') throw new ValidationError('id required');
    return { id: record.id };
  };
}

test('money validators pin the currency', () => {
  const usdOnly = moneyIn('USD') as MoneyValidator;
  assert.equal(usdOnly(Money.fromMinor('USD', 500)).minorUnits, 500);
  assert.equal(usdOnly({ currency: 'USD', amount: 500 }).minorUnits, 500);
  assert.throws(() => usdOnly(Money.fromMinor('EUR', 500)), ValidationError);
  assert.throws(() => usdOnly({ currency: 'USD', amount: 5.5 }), ValidationError);
  assert.equal((anyMoney({ currency: 'NGN', amount: 1 }) as Money).currency, 'NGN');
});

test('optional, map, refine and union compose', () => {
  assert.equal(optional(positiveInteger())(undefined), undefined);
  assert.equal(optional(positiveInteger())(3), 3);
  assert.equal(map(string(), (value: string) => value.toUpperCase())('ab'), 'AB');
  assert.equal(refine(positiveInteger(), (value: number) => value % 2 === 0, 'must be even')(8), 8);
  assert.throws(() => refine(positiveInteger(), (value: number) => value % 2 === 0, 'must be even')(7), ValidationError);
  assert.equal(union<string>('id', [positiveInteger() as unknown as (value: unknown) => string, string()])('abc'), 'abc');
  assert.throws(() => union<string>('id', [positiveInteger() as unknown as (value: unknown) => string, slug])('!!'), ValidationError);
});

test('recordOfValues validates each attribute', () => {
  const attributes = recordOfValues(string({ maxLength: 10 }));
  assert.deepEqual(attributes({ color: 'black' }), { color: 'black' });
  assert.throws(() => attributes({ color: 'way-too-long-value' }), ValidationError);
});

test('discriminated routes to the right variant', () => {
  const profile = discriminated('profile', 'kind', {
    buyer: (value: unknown) => ({ kind: 'buyer', ...(value as Record<string, unknown>) }),
    seller: (value: unknown) => ({ kind: 'seller', ...(value as Record<string, unknown>) }),
  });
  assert.equal((profile({ kind: 'seller' }) as { kind: string }).kind, 'seller');
  assert.throws(() => profile({ kind: 'ghost' }), ValidationError);
  assert.throws(() => profile({}), ValidationError);
});

test('quantityRespecting enforces MOQ and pack step', () => {
  const validate = quantityRespecting(6, 6);
  assert.equal(validate(12), 12);
  assert.throws(() => validate(6.5), ValidationError);
  assert.throws(() => validate(18), (error: unknown) => error instanceof ValidationError && /multiple of 6/.test(error.message));
  assert.throws(() => validate(1), (error: unknown) => error instanceof ValidationError && /Minimum order quantity/.test(error.message));
});
