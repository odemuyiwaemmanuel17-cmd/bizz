/**
 * Public entry point for the Bizz marketplace core.
 *
 * Import style:
 *   import { CartService, Money } from '@bizz/core';
 * Sub-modules are also deep-importable (`@bizz/core/money`) when you want a
 * smaller bundle.
 */

export * from './errors.js';
export * from './types.js';
export * from './money.js';
export * from './schema.js';
export * from './id.js';
export * from './rbac.js';

// `catalog` and `orders` both declare port interfaces with the same names, so
// their exports are listed explicitly to keep the barrel unambiguous.
export {
  CatalogService,
  InMemoryProductRepository,
  StaticCategoryRepository,
  normalizeSlug,
  type CategoryRepository,
  type CreateProductInput,
  type CreateSkuInput,
  type ProductRepository,
  type SearchFilters,
  type SearchResult,
  type StockProbe,
  type UpdateProductInput,
  type CatalogServiceOptions,
} from './catalog.js';

export {
  InventoryService,
  InMemoryStockRepository,
  InMemoryStockLedger,
  type AdjustInput,
  type ReservationResult,
  type ReserveInput,
  type StockLedger,
  type StockMovement,
  type StockRepository,
} from './inventory.js';

export {
  CartService,
  InMemoryCartRepository,
  defaultShippingAddress,
  type AddLineInput,
  type ApplyCouponInput,
  type CartServiceOptions,
  type CartView,
  type ChangeQuantityInput,
  type CouponPort,
  type CreateCartInput,
  type LineNotice,
  type PricingPorts,
  type RemoveLineInput,
  type SetAddressInput,
  type CatalogPort as CartCatalogPort,
  type StockPort as CartStockPort,
  type CartRepository,
} from './cart.js';

export {
  OrderService,
  InMemoryOrderRepository,
  inventoryStockPort,
  splitRefundAcrossLines,
  canTransition,
  assertTransition,
  allowedTransitions,
  ORDER_TRANSITIONS,
  type CancelOrderInput,
  type FulfilInput,
  type OrderConfigPort,
  type OrderQuery,
  type OrderRepository,
  type PlacedOrderResult,
  type PlaceOrderInput,
  type RefundInput,
  type ShipOrderInput,
  type UserPort,
  type CatalogPort as OrderCatalogPort,
  type StockPort as OrderStockPort,
  type CouponPort as OrderCouponPort,
} from './orders.js';

export * from './idempotency.js';

export const CORE_VERSION = '0.1.0' as const;
