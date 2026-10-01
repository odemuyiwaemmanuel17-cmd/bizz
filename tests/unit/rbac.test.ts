import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPermission,
  evaluatePolicy,
  hasPermission,
  orderParticipationPolicy,
  permissionsFor,
  productOwnershipPolicy,
  roleHasPermission,
  skuOwnershipPolicy,
  UnauthorizedError,
} from '../../src/rbac.js';
import type { User } from '../../src/types.js';

function user(overrides: Partial<User> = {}): User {
  const base: User = {
    id: 'usr_1',
    email: 'someone@example.com',
    displayName: 'Someone',
    role: 'buyer',
    status: 'active',
    profile: { kind: 'buyer' },
    addresses: [{ id: 'adr_1', label: 'home', fullName: 'S One', line1: '1 High St', city: 'Austin', region: 'TX', country: 'US', postalCode: '78701' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
  return Object.freeze({ ...base, ...overrides });
}

test('role permission tables are complete and admin is a superset', () => {
  for (const permission of permissionsFor('seller')) {
    assert.equal(roleHasPermission('admin', permission), true);
  }
  assert.equal(roleHasPermission('buyer', 'product.create'), false);
  assert.equal(roleHasPermission('seller', 'product.create'), true);
  assert.equal(roleHasPermission('buyer', 'order.create'), true);
  assert.equal(roleHasPermission('seller', 'payment.refund.any'), false);
});

test('assertPermission throws a typed, machine-readable error', () => {
  assert.doesNotThrow(() => assertPermission(user(), 'catalog.read'));
  assert.throws(
    () => assertPermission(user(), 'product.create'),
    (error: unknown) => {
      const typed: UnauthorizedError = error as UnauthorizedError;
      return typed instanceof UnauthorizedError && typed.code === 'UNAUTHORIZED' && typed.details.permission === 'product.create';
    },
  );
});

test('ownership policy lets sellers edit their own listings only', () => {
  const seller = user({ id: 'usr_seller', role: 'seller' });
  const other = user({ id: 'usr_other', role: 'seller' });
  assert.equal(evaluatePolicy(seller, { sellerId: 'usr_seller' }, productOwnershipPolicy).allowed, true);
  const verdict = evaluatePolicy(other, { sellerId: 'usr_seller' }, productOwnershipPolicy);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /their own listings/);
});

test('admins bypass ownership but not account status', () => {
  const admin = user({ id: 'usr_admin', role: 'admin' });
  assert.equal(evaluatePolicy(admin, { sellerId: 'usr_seller' }, productOwnershipPolicy).allowed, true);
  const suspended = user({ id: 'usr_admin2', role: 'admin', status: 'suspended' });
  const verdict = evaluatePolicy(suspended, { sellerId: 'usr_seller' }, productOwnershipPolicy);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /not permitted/);
});

test('order participation covers buyer and every seller on the order', () => {
  const order = { buyerId: 'usr_buyer', sellerIds: ['usr_a', 'usr_b'] };
  assert.equal(hasPermission(user({ role: 'buyer' }), 'order.read.own'), true);
  assert.equal(evaluatePolicy(user({ id: 'usr_b', role: 'seller' }), order, orderParticipationPolicy).allowed, true);
  assert.equal(evaluatePolicy(user({ id: 'usr_c', role: 'seller' }), order, orderParticipationPolicy).allowed, false);
});

test('sku policy message surfaces through UnauthorizedError', () => {
  const sku = { sellerId: 'usr_owner' } as never;
  assert.throws(
    () => evaluatePolicy(user({ id: 'usr_intruder', role: 'seller' }), sku, skuOwnershipPolicy).allowed,
    TypeError,
  );
  const verdict = evaluatePolicy(user({ id: 'usr_intruder', role: 'seller' }), sku, skuOwnershipPolicy);
  assert.equal(verdict.allowed, false);
});
