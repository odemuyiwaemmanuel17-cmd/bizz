/**
 * Domain vocabulary for Bizz: users (buyers / sellers / admins), catalog
 * offerings (products + SKUs) and the order lifecycle.
 *
 * These are plain, `readonly` data shapes — persistence-agnostic and safe to
 * serialize straight to JSON. All invariants are enforced by the services and
 * validated with `schema.ts`.
 */

import type { Currency, Money } from './money.js';

/* -------------------------------------------------------------------------- */
/* Users & roles                                                              */
/* -------------------------------------------------------------------------- */

export const USER_ROLES = ['buyer', 'seller', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ACCOUNT_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface Address {
  readonly id: string;
  readonly label: string;
  readonly fullName: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region: string;
  /** ISO 3166-1 alpha-2, upper-case. */
  readonly country: string;
  readonly postalCode: string;
  readonly phone?: string;
  readonly isDefaultForShipping?: boolean;
}

export interface BuyerProfile {
  readonly kind: 'buyer';
  readonly companyName?: string;
  readonly taxId?: string;
  readonly defaultAddressId?: string;
  readonly poNumberRequired?: boolean;
}

export interface SellerProfile {
  readonly kind: 'seller';
  readonly displayName: string;
  readonly slug: string;
  readonly bio?: string;
  readonly payoutCurrency: Currency;
  readonly serviceAreaCountries: readonly string[];
  readonly leadTimeDays: number;
  readonly ratingAverage: number;
  readonly ratingCount: number;
}

export type UserProfile = BuyerProfile | SellerProfile;

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly status: AccountStatus;
  readonly profile: UserProfile;
  readonly addresses: readonly Address[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export function isSeller(user: Pick<User, 'role'>): boolean {
  return user.role === 'seller' || user.role === 'admin';
}

export function isBuyer(user: Pick<User, 'role'>): boolean {
  return user.role === 'buyer' || user.role === 'admin';
}

export function findAddress(user: User, addressId: string): Address | undefined {
  return user.addresses.find((candidate: Address) => candidate.id === addressId);
}

export function defaultShippingAddress(user: User): Address | undefined {
  return user.addresses.find((candidate: Address) => candidate.isDefaultForShipping === true) ?? user.addresses[0];
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly parentId?: string;
  readonly path: readonly string[];
}

/** Stock-keeping unit: the purchasable thing that carries price + inventory. */
export interface Sku {
  readonly id: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly skuCode: string;
  readonly title: string;
  readonly description?: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly unitPrice: Money;
  readonly compareAtPrice?: Money;
  /** Minimum purchase quantity — Bizz is wholesale-first. */
  readonly minOrderQuantity: number;
  /** Quantity step buyers must respect (packs of 6, pallets of 24...). */
  readonly quantityStep: number;
  readonly currency: Currency;
  readonly weightGrams?: number;
  readonly hsCode?: string;
  readonly imageUrl?: string;
  readonly status: ProductStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface Product {
  readonly id: string;
  readonly sellerId: string;
  readonly title: string;
  readonly description: string;
  readonly slug: string;
  readonly categoryId: string;
  readonly tags: readonly string[];
  readonly brand?: string;
  readonly skus: readonly Sku[];
  readonly status: ProductStatus;
  readonly publishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** Derived availability bucket used by search + storefront badges. */
export const STOCK_LEVELS = ['in_stock', 'low_stock', 'out_of_stock'] as const;
export type StockLevel = (typeof STOCK_LEVELS)[number];

export interface StockRecord {
  readonly skuId: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly reorderPoint: number;
  readonly locationCode?: string;
  readonly version: number;
  readonly updatedAt: string;
}

export function availableQuantity(record: StockRecord): number {
  return Math.max(0, record.onHand - record.reserved);
}

export function stockLevelOf(record: StockRecord): StockLevel {
  const available = availableQuantity(record);
  if (available <= 0) return 'out_of_stock';
  if (available <= record.reorderPoint) return 'low_stock';
  return 'in_stock';
}

/* -------------------------------------------------------------------------- */
/* Cart & orders                                                              */
/* -------------------------------------------------------------------------- */

export interface CartLine {
  readonly skuId: string;
  readonly sellerId: string;
  readonly quantity: number;
  /** Snapshot of the unit price when the line was added/refreshed. */
  readonly unitPrice: Money;
  readonly addedAt: string;
}

export interface Cart {
  readonly id: string;
  readonly buyerId: string;
  readonly currency: Currency;
  readonly lines: readonly CartLine[];
  readonly couponCode?: string;
  readonly shippingAddressId?: string;
  readonly updatedAt: string;
  readonly version: number;
}

export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['unpaid', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FULFILMENT_STATUSES = ['unfulfilled', 'partial', 'fulfilled'] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

/** Immutable snapshot of a SKU captured at checkout time. */
export interface OrderItemSnapshot {
  readonly skuId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly skuCode: string;
  readonly title: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly unitPrice: Money;
}

export interface OrderItem {
  readonly lineId: string;
  readonly snapshot: OrderItemSnapshot;
  readonly quantity: number;
  readonly subtotal: Money;
  /** Discount allocated to this line after order-level rules ran. */
  readonly discount: Money;
  readonly netTotal: Money;
  readonly fulfilledQuantity: number;
  readonly refundedQuantity: number;
}

export interface ShippingInfo {
  readonly address: Address;
  readonly methodCode: string;
  readonly methodName: string;
  readonly cost: Money;
  readonly trackingNumber?: string;
  readonly carrier?: string;
  readonly shippedAt?: string;
  readonly deliveredAt?: string;
}

export interface TimelineEvent {
  readonly at: string;
  readonly type: string;
  readonly actorId: string;
  readonly note?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OrderTotals {
  readonly itemsTotal: Money;
  readonly discountTotal: Money;
  readonly shippingTotal: Money;
  readonly taxTotal: Money;
  readonly serviceFeeTotal: Money;
  readonly grandTotal: Money;
  readonly amountPaid: Money;
  readonly amountRefunded: Money;
  readonly balanceDue: Money;
}

export interface Order {
  readonly id: string;
  readonly number: string;
  readonly buyerId: string;
  readonly sellerIds: readonly string[];
  readonly currency: Currency;
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly fulfilmentStatus: FulfilmentStatus;
  readonly items: readonly OrderItem[];
  readonly totals: OrderTotals;
  readonly shipping: ShippingInfo;
  readonly couponCode?: string;
  readonly purchaseOrderNumber?: string;
  readonly buyerNote?: string;
  readonly timeline: readonly TimelineEvent[];
  readonly idempotencyKey?: string;
  readonly placedAt?: string;
  readonly cancelledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** Human-readable summary for dashboards / e-mail receipts. */
export function orderSummary(order: Order): string {
  const units = order.items.reduce((sum: number, item: OrderItem) => sum + item.quantity, 0);
  return `${order.number}: ${String(order.items.length)} line(s), ${String(units)} unit(s), ${order.totals.grandTotal.format()}`;
}

export function outstandingBalance(order: Order): Money {
  return order.totals.balanceDue;
}

export function isClosed(order: Order): boolean {
  return order.status === 'cancelled' || order.status === 'refunded' || order.status === 'delivered';
}
