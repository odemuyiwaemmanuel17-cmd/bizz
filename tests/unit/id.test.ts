import test from 'node:test';
import assert from 'node:assert/strict';

import { FrozenClock, OrderNumberGenerator, SequentialIdGenerator, fnv1a } from '../../src/id.js';
import { ValidationError } from '../../src/errors.js';

test('SequentialIdGenerator is deterministic per seed', () => {
  const a = new SequentialIdGenerator('seed-a');
  const b = new SequentialIdGenerator('seed-a');
  assert.equal(a.next('prd'), b.next('prd'));
  assert.match(a.peek('sku'), /^sku_[0-9a-z]{10}$/);
});

test('ids never repeat within or across prefixes', () => {
  const generator = new SequentialIdGenerator('shop');
  const seen = new Set<string>();
  for (let index = 0; index < 5000; index += 1) {
    seen.add(generator.next(index % 2 === 0 ? 'prd' : 'sku'));
  }
  assert.equal(seen.size, 5000, 'expected no collisions in 5k ids');
});

test('peek does not advance the counter but next does', () => {
  const generator = new SequentialIdGenerator('x');
  const peeked: string = generator.peek('ord');
  assert.equal(generator.peek('ord'), peeked);
  assert.equal(generator.next('ord'), peeked);
  assert.notEqual(generator.next('ord'), peeked);
  generator.reset();
  assert.equal(generator.next('ord'), peeked);
});

test('generator rejects degenerate configuration', () => {
  assert.throws(() => new SequentialIdGenerator(''), ValidationError);
  assert.throws(() => new SequentialIdGenerator('   '), ValidationError);
  assert.throws(() => new SequentialIdGenerator('ok').next('prd', 2), ValidationError);
});

test('fnv1a is stable and order sensitive', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'));
  assert.notEqual(fnv1a('abc'), fnv1a('abd'));
  assert.ok(fnv1a('') >= 0);
});

test('FrozenClock advances deterministically', () => {
  const clock = new FrozenClock('2026-07-18T10:00:00.000Z');
  assert.equal(clock.nowIso(), '2026-07-18T10:00:00.000Z');
  clock.advance(1500);
  assert.equal(clock.now().getTime() - Date.parse('2026-07-18T10:00:00.000Z'), 1500);
  assert.throws(() => new FrozenClock('not-a-date'), ValidationError);
  assert.throws(() => clock.advance(Number.NaN), ValidationError);
});

test('OrderNumberGenerator resets its sequence each day', () => {
  const clock = new FrozenClock('2026-07-18T00:00:00.000Z');
  const numbers = new OrderNumberGenerator(clock);
  assert.equal(numbers.next(), 'BIZ-20260718-000001');
  assert.equal(numbers.next(), 'BIZ-20260718-000002');
  clock.advance(24 * 60 * 60 * 1000 + 1);
  assert.equal(numbers.next(), 'BIZ-20260719-000001');
  assert.throws(() => new OrderNumberGenerator(clock, 'too-long-prefix'), ValidationError);
});
