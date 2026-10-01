/**
 * Role-based access control.
 *
 * Permissions are `"resource.action"` strings. Roles map to permission lists,
 * and `admin` is a superset of everything. Ownership rules (a seller may only
 * touch their own products) are expressed as *policies* that additionally
 * compare the actor against the record — never by trusting client-side ids.
 */

import { UnauthorizedError } from './errors.js';
import type { Address, Sku, User, UserRole } from './types.js';
import { findAddress } from './types.js';

/** Re-exported so consumers can catch auth failures from a single entry point. */
export { UnauthorizedError };

export const PERMISSIONS = [
  'catalog.read',
  'catalog.publish',
  'product.create',
  'product.update.own',
  'product.delete.own',
  'product.update.any',
  'sku.manage.own',
  'inventory.read',
  'inventory.adjust.own',
  'inventory.adjust.any',
  'order.read.own',
  'order.read.any',
  'order.create',
  'order.cancel.own',
  'order.fulfil.own',
  'payment.refund.any',
  'user.read',
  'user.update.self',
  'user.manage',
  'address.manage.self',
  'analytics.read.own',
  'analytics.read.any',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  buyer: [
    'catalog.read',
    'order.read.own',
    'order.create',
    'order.cancel.own',
    'user.read',
    'user.update.self',
    'address.manage.self',
  ],
  seller: [
    'catalog.read',
    'catalog.publish',
    'product.create',
    'product.update.own',
    'product.delete.own',
    'product.update.any',
    'sku.manage.own',
    'inventory.read',
    'inventory.adjust.own',
    'order.read.own',
    'order.read.any',
    'order.fulfil.own',
    'user.read',
    'user.update.self',
    'analytics.read.own',
  ],
  admin: [...PERMISSIONS],
};

export function permissionsFor(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  if (role === 'admin') return true;
  return permissionsFor(role).includes(permission);
}

export function hasPermission(actor: Pick<User, 'role'>, permission: Permission): boolean {
  return roleHasPermission(actor.role, permission);
}

export function assertPermission(actor: Pick<User, 'role'>, permission: Permission, resource = 'resource'): void {
  if (!hasPermission(actor, permission)) {
    throw new UnauthorizedError(`Role '${actor.role}' lacks permission '${permission}' for ${resource}`, {
      role: actor.role,
      permission,
    });
  }
}

/** A policy answers "may this actor act on *this* record?". */
export interface Policy<TResource> {
  readonly permission: Permission;
  readonly owns: (actor: User, resource: TResource) => boolean;
  readonly message?: string;
}

export function evaluatePolicy<TResource>(
  actor: User,
  resource: TResource,
  policy: Policy<TResource>,
): { readonly allowed: boolean; readonly reason: string } {
  if (actor.status !== 'active') {
    return { allowed: false, reason: `Account status '${actor.status}' is not permitted to act` };
  }
  if (!roleHasPermission(actor.role, policy.permission)) {
    return { allowed: false, reason: `Role '${actor.role}' lacks permission '${policy.permission}'` };
  }
  // Admins bypass ownership checks; they still need an active account.
  if (actor.role === 'admin') return { allowed: true, reason: 'granted via admin' };
  if (!policy.owns(actor, resource)) {
    return { allowed: false, reason: policy.message ?? 'Actor does not own this resource' };
  }
  return { allowed: true, reason: 'granted via ownership' };
}

export function assertPolicy<TResource>(actor: User, resource: TResource, policy: Policy<TResource>): void {
  const verdict = evaluatePolicy(actor, resource, policy);
  if (!verdict.allowed) {
    throw new UnauthorizedError(verdict.reason, { permission: policy.permission, actorId: actor.id });
  }
}

/* -------------------------------------------------------------------------- */
/* Concrete policies                                                          */
/* -------------------------------------------------------------------------- */

export const productOwnershipPolicy: Policy<{ readonly sellerId: string }> = {
  permission: 'product.update.own',
  owns: (actor: User, resource: { sellerId: string }): boolean => resource.sellerId === actor.id,
  message: 'Sellers may only modify their own listings',
};

export const skuOwnershipPolicy: Policy<Sku> = {
  permission: 'sku.manage.own',
  owns: (actor: User, sku: Sku): boolean => sku.sellerId === actor.id,
  message: 'Sellers may only manage stock on their own SKUs',
};

export const orderParticipationPolicy: Policy<{ readonly buyerId: string; readonly sellerIds: readonly string[] }> = {
  permission: 'order.read.own',
  owns: (
    actor: User,
    order: { buyerId: string; sellerIds: readonly string[] },
  ): boolean => order.buyerId === actor.id || order.sellerIds.includes(actor.id),
  message: 'Only the buyer or a participating seller can view this order',
};

export const addressOwnershipPolicy: Policy<Address> = {
  permission: 'address.manage.self',
  owns: (actor: User, address: Address): boolean => findAddress(actor, address.id) !== undefined,
  message: 'Address not found on this account',
};

/** Convenience guard used by services before mutating catalog rows. */
export function assertCanManageSku(actor: User, sku: Sku): void {
  assertPolicy(actor, sku, skuOwnershipPolicy);
}

export function assertActiveAccount(actor: Pick<User, 'status'>): void {
  if (actor.status !== 'active') {
    throw new UnauthorizedError(`Account status '${actor.status}' cannot perform this action`, {
      status: actor.status,
    });
  }
}
