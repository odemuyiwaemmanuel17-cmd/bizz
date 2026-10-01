/**
 * Order lifecycle.
 *
 * Two state machines are modelled explicitly so illegal transitions are a
 * compile-time-plus-run-time impossibility:
 *
 *   pending_payment -> paid | cancelled
 *   paid            -> processing | cancelled | refunded
 *   processing      -> shipped | cancelled | refunded
 *   shipped         -> delivered | refunded
 *   delivered       -> refunded
 *   cancelled       -> (terminal)
 *   refunded        -> (terminal)
 *
 * Checkout is crash-safe: stock is reserved first, and if the order row cannot
 * be persisted every reservation is released again (Saga compensation).
 * Idempotency keys make client retries return the original order instead of
 * creating duplicates.
 */

import { ConflictError, InsufficientStockError, InvalidStateError, NotFoundError, UnauthorizedError, ValidationError } from './errors.js';
import type { Clock } from './id.js';
import { OrderNumberGenerator, SequentialIdGenerator } from './id.js';
import { InventoryService } from './inventory.js';
import { Money, type Currency } from './money.js';
import {
  allocate,
  PricingEngine,
  recomputeOrderTotals,
  type Coupon,
  type PriceQuote,
  type RateRule,
  type ShippingMethod,
  type SkuPricing,
} from './pricing.js';
import { assertActiveAccount, assertPermission, evaluatePolicy, orderParticipationPolicy } from './rbac.js';
import { identifier, positiveInteger } from './schema.js';
import type { Address, Cart, Order, OrderItem, OrderStatus, PaymentStatus, FulfilmentStatus, Sku, TimelineEvent, User } from './types.js';
import { availableQuantity, findAddress, isClosed, type StockRecord } from './types.js';

/* -------------------------------------------------------------------------- */
/* State machines                                                             */
/* -------------------------------------------------------------------------- */

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = Object.freeze({
  pending_payment: Object.freeze(['paid', 'cancelled'] as const),
  paid: Object.freeze(['processing', 'cancelled', 'refunded'] as const),
  processing: Object.freeze(['shipped', 'cancelled', 'refunded'] as const),
  shipped: Object.freeze(['delivered', 'refunded'] as const),
  delivered: Object.freeze(['refunded'] as const),
  cancelled: Object.freeze([] as const),
  refunded: Object.freeze([] as const),
});

const PAYMENT_BY_ORDER_STATUS: Readonly<Record<OrderStatus, PaymentStatus>> = Object.freeze({
  pending_payment: 'unpaid',
  paid: 'captured',
  processing: 'captured',
  shipped: 'captured',
  delivered: 'captured',
  cancelled: 'refunded',
  refunded: 'refunded',
});

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateError('Order', from, to);
}

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[from] ?? [];
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                      */
/* -------------------------------------------------------------------------- */

export interface CatalogPort {
  getSku(skuId: string): Promise<Sku | undefined>;
}

export interface StockPort {
  getStock(skuId: string): Promise<StockRecord | undefined>;
}

export interface UserPort {
  getUser(userId: string): Promise<User | undefined>;
}

export interface OrderRepository {
  load(orderId: string): Promise<Order | undefined>;
  findByIdempotencyKey(key: string): Promise<Order | undefined>;
  save(order: Order, expectedVersion: number): Promise<Order>;
}

export interface CouponPort {
  find(code: string): Promise<Coupon | undefined>;
}

export interface OrderConfigPort {
  shippingMethods(): readonly ShippingMethod[];
  taxRules(): readonly RateRule[];
  serviceFeeBasisPoints(): number;
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders: Map<string, Order> = new Map();
  private readonly byKey: Map<string, string> = new Map();

  public async load(orderId: string): Promise<Order | undefined> {
    return this.orders.get(orderId);
  }

  public async findByIdempotencyKey(key: string): Promise<Order | undefined> {
    const orderId: string | undefined = this.byKey.get(key);
    return orderId === undefined ? undefined : this.orders.get(orderId);
  }

  public async save(order: Order, expectedVersion: number): Promise<Order> {
    const current: Order | undefined = this.orders.get(order.id);
    if (current !== undefined && current.version !== expectedVersion) {
      throw new ConflictError(`Order '${order.id}' changed concurrently`, {
        orderId: order.id,
        expectedVersion,
        actualVersion: current.version,
      });
    }
    const frozen: Order = Object.freeze({ ...order, items: Object.freeze([...order.items]) });
    this.orders.set(frozen.id, frozen);
    if (frozen.idempotencyKey !== undefined) this.byKey.set(frozen.idempotencyKey, frozen.id);
    return frozen;
  }

  public get size(): number {
    return this.orders.size;
  }
}

/** Local inventory adapter so `orders.ts` depends only on the ports above. */
export function inventoryStockPort(service: InventoryService): StockPort {
  return {
    async getStock(skuId: string): Promise<StockRecord | undefined> {
      try {
        return await service.get(skuId);
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Inputs / outputs                                                           */
/* -------------------------------------------------------------------------- */

export interface PlaceOrderInput {
  readonly cart: Cart;
  readonly actor: User;
  readonly shippingAddressId: string;
  readonly shippingMethodCode: string;
  readonly idempotencyKey: string;
  readonly purchaseOrderNumber?: string;
  readonly buyerNote?: string;
  readonly expectedCartVersion?: number;
}

export interface CancelOrderInput {
  readonly orderId: string;
  readonly actor: User;
  readonly reason: string;
  readonly restock?: boolean;
  readonly expectedVersion?: number;
}

export interface ShipOrderInput {
  readonly orderId: string;
  readonly actor: User;
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly lines: readonly { readonly skuId: string; readonly quantity: number }[];
  readonly expectedVersion?: number;
}

export interface RefundInput {
  readonly orderId: string;
  readonly actor: User;
  readonly amount: Money;
  readonly reason: string;
  readonly expectedVersion?: number;
}

export interface FulfilInput {
  readonly orderId: string;
  readonly actor: User;
  readonly lines: readonly { readonly skuId: string; readonly quantity: number }[];
  readonly expectedVersion?: number;
}

export interface OrderQuery {
  readonly buyerId?: string;
  readonly sellerId?: string;
  readonly status?: OrderStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface PlacedOrderResult {
  readonly order: Order;
  readonly replayed: boolean;
}

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export class OrderService {
  private readonly catalog: CatalogPort;
  private readonly stock: StockPort;
  private readonly users: UserPort;
  private readonly repository: OrderRepository;
  private readonly coupons: CouponPort | undefined;
  private readonly config: OrderConfigPort;
  private readonly inventory: InventoryService;
  private readonly clock: Clock;
  private readonly ids: SequentialIdGenerator;
  private readonly numbers: OrderNumberGenerator;

  public constructor(options: {
    readonly catalog: CatalogPort;
    readonly stock: StockPort;
    readonly users: UserPort;
    readonly repository: OrderRepository;
    readonly coupons?: CouponPort;
    readonly config: OrderConfigPort;
    readonly inventory: InventoryService;
    readonly clock: Clock;
    readonly idGenerator?: SequentialIdGenerator;
    readonly orderNumbers?: OrderNumberGenerator;
  }) {
    for (const key of ['catalog', 'stock', 'users', 'repository', 'config', 'inventory', 'clock'] as const) {
      if (options[key] === undefined) throw ValidationError.field(key, `${key} is required by OrderService`);
    }
    this.catalog = options.catalog;
    this.stock = options.stock;
    this.users = options.users;
    this.repository = options.repository;
    this.coupons = options.coupons;
    this.config = options.config;
    this.inventory = options.inventory;
    this.clock = options.clock;
    this.ids = options.idGenerator ?? new SequentialIdGenerator('orders');
    this.numbers = options.orderNumbers ?? new OrderNumberGenerator(options.clock);
  }

  /* ------------------------------- checkout ------------------------------ */

  public async place(input: PlaceOrderInput): Promise<PlacedOrderResult> {
    const key: string = this.assertIdempotencyKey(input.idempotencyKey);
    assertActiveAccount(input.actor);
    assertPermission(input.actor, 'order.create', 'checkout');

    const existing: Order | undefined = await this.repository.findByIdempotencyKey(key);
    if (existing !== undefined) {
      if (existing.buyerId !== input.actor.id) {
        throw new ConflictError('Idempotency key was already used by another account', { key });
      }
      return { order: existing, replayed: true };
    }

    const cart: Cart = input.cart;
    if (input.expectedCartVersion !== undefined && input.expectedCartVersion !== cart.version) {
      throw new ConflictError(`Cart '${cart.id}' changed during checkout; re-render and retry`, {
        cartId: cart.id,
        expectedVersion: input.expectedCartVersion,
        actualVersion: cart.version,
      });
    }
    if (cart.lines.length === 0) throw new ValidationError('Cannot place an order for an empty cart');
    if (cart.buyerId !== input.actor.id && input.actor.role !== 'admin') {
      throw new UnauthorizedError('You may only place your own orders', { cartId: cart.id });
    }

    const address: Address = await this.resolveAddress(input.actor, input.shippingAddressId);
    const method: ShippingMethod = this.resolveShippingMethod(input.shippingMethodCode, address);
    const coupon: Coupon | undefined = await this.resolveCoupon(cart.couponCode);

    // Validate SKUs, quantities and prices against the live catalog.
    interface Prepared {
      readonly sku: Sku;
      readonly quantity: number;
      readonly lineId: string;
    }
    const prepared: Prepared[] = [];
    for (const line of cart.lines) {
      const sku: Sku | undefined = await this.catalog.getSku(line.skuId);
      if (sku === undefined || sku.status !== 'published') {
        throw new ConflictError(`'${line.skuId}' is no longer purchasable`, { skuId: line.skuId });
      }
      const quantity: number = await this.inventory.assertPurchasable(sku, line.quantity);
      prepared.push({ sku, quantity, lineId: this.ids.next('ord') });
    }

    const skusById = new Map<string, Sku>(prepared.map((item: Prepared) => [item.sku.id, item.sku]));
    const quote: PriceQuote = this.buildQuote(prepared, cart.currency, address, method, coupon, skusById);
    if (quote.grandTotal.isNegative) throw new ConflictError('Computed order total is negative; refusing to place');

    // Reserve first, persist second, compensate on failure.
    const reservations = await this.inventory.reserveAll(
      prepared.map((item: Prepared) => ({
        skuId: item.sku.id,
        quantity: item.quantity,
        actorId: input.actor.id,
        reference: cart.id,
      })),
    );

    const now: string = this.clock.now().toISOString();
    const orderId: string = this.ids.next('ord');
    try {
      const items: OrderItem[] = quote.lines.map((pricedLine, index: number) => {
        const sku: Sku | undefined = skusById.get(pricedLine.skuId);
        if (sku === undefined) throw new NotFoundError('Sku', pricedLine.skuId);
        const source: Prepared | undefined = prepared[index];
        return Object.freeze({
          lineId: source?.lineId ?? pricedLine.skuId,
          snapshot: Object.freeze({
            skuId: sku.id,
            productId: sku.productId,
            sellerId: sku.sellerId,
            skuCode: sku.skuCode,
            title: sku.title,
            attributes: sku.attributes,
            unitPrice: pricedLine.unitListPrice,
          }),
          quantity: pricedLine.quantity,
          subtotal: pricedLine.grossAmount,
          discount: pricedLine.discountTotal,
          netTotal: pricedLine.netAmount,
          fulfilledQuantity: 0,
          refundedQuantity: 0,
        });
      });

      const totals = recomputeOrderTotals({
        currency: cart.currency,
        itemsTotal: quote.itemsTotal,
        discountTotal: quote.discountTotal,
        shippingTotal: quote.shippingTotal,
        taxTotal: quote.taxTotal,
        serviceFeeTotal: quote.serviceFeeTotal,
        amountPaid: Money.zero(cart.currency),
        amountRefunded: Money.zero(cart.currency),
      });

      const sellerIds: readonly string[] = Object.freeze([
        ...new Set(items.map((item: OrderItem) => item.snapshot.sellerId)),
      ]);

      const order: Order = Object.freeze({
        id: orderId,
        number: this.numbers.next(),
        buyerId: input.actor.id,
        sellerIds,
        currency: cart.currency,
        status: 'pending_payment',
        paymentStatus: 'unpaid',
        fulfilmentStatus: 'unfulfilled',
        items: Object.freeze(items),
        totals: Object.freeze(totals),
        shipping: Object.freeze({
          address,
          methodCode: method.code,
          methodName: method.name,
          cost: quote.shippingTotal,
        }),
        couponCode: coupon?.code,
        purchaseOrderNumber: input.purchaseOrderNumber?.trim(),
        buyerNote: input.buyerNote?.trim(),
        timeline: Object.freeze([
          { at: now, type: 'order.placed', actorId: input.actor.id, note: `Cart ${cart.id}` },
        ] as readonly TimelineEvent[]),
        idempotencyKey: key,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });

      const saved: Order = await this.repository.save(order, 0);
      return { order: saved, replayed: false };
    } catch (error) {
      // Compensate: give every reserved unit back before surfacing the failure.
      for (const reservation of reservations) {
        try {
          await this.inventory.release({
            skuId: reservation.skuId,
            quantity: reservation.quantity,
            actorId: 'system:compensation',
            reference: `rollback:${orderId}`,
          });
        } catch {
          // A failed compensation must not mask the original error; the nightly
          // reconciliation job picks these up from the ledger.
        }
      }
      throw error;
    }
  }

  /* ------------------------------ lifecycle ------------------------------ */

  public async markPaid(input: { orderId: string; actor: User; amount: Money; reference: string; expectedVersion?: number }): Promise<Order> {
    const order: Order = await this.requireReadable(input.orderId, input.actor);
    assertPermission(input.actor, 'user.manage', 'payment capture');
    this.checkVersion(order, input.expectedVersion);
    assertTransition(order.status, 'paid');
    if (input.amount.currency !== order.currency) {
      throw ValidationError.field('amount', `Payment must be in ${order.currency}`);
    }
    if (!input.amount.equals(order.totals.grandTotal)) {
      throw new ConflictError('Payment amount does not match the order total', {
        expected: order.totals.grandTotal.minorUnits,
        received: input.amount.minorUnits,
      });
    }
    const next: Order = this.mutate(order, {
      status: 'paid',
      paymentStatus: 'captured',
      placedAt: this.clock.now().toISOString(),
      totals: Object.freeze({ ...order.totals, amountPaid: input.amount, balanceDue: Money.zero(order.currency) }),
    });
    const saved: Order = await this.repository.save(this.withEvent(next, 'payment.captured', input.actor.id, input.reference), order.version);
    return saved;
  }

  public async startProcessing(input: { orderId: string; actor: User; expectedVersion?: number }): Promise<Order> {
    const order: Order = await this.requireSellerOf(input.orderId, input.actor);
    this.checkVersion(order, input.expectedVersion);
    assertTransition(order.status, 'processing');
    return await this.repository.save(
      this.withEvent(this.mutate(order, { status: 'processing' }), 'order.processing', input.actor.id),
      order.version,
    );
  }

  /** Partial or full fulfilment; commits the matching stock reservations. */
  public async fulfil(input: FulfilInput): Promise<Order> {
    const order: Order = await this.requireSellerOf(input.orderId, input.actor);
    this.checkVersion(order, input.expectedVersion);
    if (order.status !== 'paid' && order.status !== 'processing') {
      throw new InvalidStateError('Order', order.status, 'processing', 'an order must be paid before it can be fulfilled');
    }
    const deltas = this.resolveLineQuantities(order, input.lines);
    const items: OrderItem[] = order.items.map((item: OrderItem) => {
      const extra: number = deltas.get(item.snapshot.skuId) ?? 0;
      const fulfilled: number = item.fulfilledQuantity + extra;
      if (fulfilled > item.quantity) {
        throw new ConflictError(`Cannot fulfil more units of '${item.snapshot.skuCode}' than were ordered`, {
          skuId: item.snapshot.skuId,
          ordered: item.quantity,
          alreadyFulfilled: item.fulfilledQuantity,
          requested: extra,
        });
      }
      return Object.freeze({ ...item, fulfilledQuantity: fulfilled });
    });
    const status: OrderStatus = order.status === 'paid' ? 'processing' : order.status;
    const fulfilmentStatus: FulfilmentStatus = allComplete(items) ? 'fulfilled' : 'partial';
    const next: Order = this.mutate(order, { items: Object.freeze(items), status, fulfilmentStatus });
    return await this.repository.save(
      this.withEvent(next, 'order.fulfilled', input.actor.id, describeDeltas(deltas)),
      order.version,
    );
  }

  public async ship(input: ShipOrderInput): Promise<Order> {
    const order: Order = await this.requireSellerOf(input.orderId, input.actor);
    this.checkVersion(order, input.expectedVersion);
    assertTransition(order.status, 'shipped');
    if (typeof input.trackingNumber !== 'string' || input.trackingNumber.trim().length < 4) {
      throw ValidationError.field('trackingNumber', 'A tracking number of at least 4 characters is required');
    }
    if (typeof input.carrier !== 'string' || input.carrier.trim().length === 0) {
      throw ValidationError.field('carrier', 'Carrier is required');
    }
    const deltas = this.resolveLineQuantities(order, input.lines);
    if (deltas.size === 0) throw new ValidationError('Shipments must contain at least one line');

    const items: OrderItem[] = order.items.map((item: OrderItem) => {
      const extra: number = deltas.get(item.snapshot.skuId) ?? 0;
      const fulfilled: number = Math.min(item.quantity, item.fulfilledQuantity + extra);
      return Object.freeze({ ...item, fulfilledQuantity: fulfilled });
    });

    // Consume the reservations that leave the warehouse.
    for (const [skuId, quantity] of deltas) {
      await this.inventory.commit({ skuId, quantity, actorId: input.actor.id, reference: order.number });
    }

    const now: string = this.clock.now().toISOString();
    const next: Order = this.mutate(order, {
      items: Object.freeze(items),
      status: 'shipped',
      fulfilmentStatus: allComplete(items) ? 'fulfilled' : 'partial',
      shipping: Object.freeze({
        ...order.shipping,
        carrier: input.carrier.trim(),
        trackingNumber: input.trackingNumber.trim(),
        shippedAt: now,
      }),
    });
    return await this.repository.save(
      this.withEvent(next, 'order.shipped', input.actor.id, `${input.carrier} ${input.trackingNumber}`),
      order.version,
    );
  }

  public async markDelivered(input: { orderId: string; actor: User; expectedVersion?: number }): Promise<Order> {
    const order: Order = await this.requireSellerOf(input.orderId, input.actor);
    this.checkVersion(order, input.expectedVersion);
    assertTransition(order.status, 'delivered');
    if (order.fulfilmentStatus !== 'fulfilled') {
      throw new ConflictError('Cannot mark an order delivered until every line is fulfilled', {
        orderId: order.id,
        fulfilmentStatus: order.fulfilmentStatus,
      });
    }
    const now: string = this.clock.now().toISOString();
    return await this.repository.save(
      this.withEvent(
        this.mutate(order, {
          status: 'delivered',
          shipping: Object.freeze({ ...order.shipping, deliveredAt: now }),
        }),
        'order.delivered',
        input.actor.id,
      ),
      order.version,
    );
  }

  public async cancel(input: CancelOrderInput): Promise<Order> {
    const order: Order = await this.load(input.orderId);
    const isParticipant: boolean = order.buyerId === input.actor.id || order.sellerIds.includes(input.actor.id);
    const verdict = isParticipant
      ? evaluatePolicy(input.actor, { buyerId: order.buyerId, sellerIds: order.sellerIds }, orderParticipationPolicy)
      : { allowed: false, reason: 'not a participant' };
    const mayCancel: boolean = input.actor.role === 'admin' || verdict.allowed;
    if (!mayCancel) throw new UnauthorizedError('Only the buyer, a participating seller or an admin can cancel this order');
    assertActiveAccount(input.actor);
    this.checkVersion(order, input.expectedVersion);
    assertTransition(order.status, 'cancelled');
    const reason: string = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length === 0) throw ValidationError.field('reason', 'A cancellation reason is required');

    if (input.restock !== false) {
      for (const item of order.items) {
        const outstanding: number = item.quantity - item.fulfilledQuantity;
        if (outstanding <= 0) continue;
        try {
          await this.inventory.release({
            skuId: item.snapshot.skuId,
            quantity: outstanding,
            actorId: input.actor.id,
            reference: `${order.number}:cancel`,
          });
        } catch (error) {
          if (error instanceof ConflictError) continue; // already released/committed
          throw error;
        }
      }
    }

    const refundRequired: boolean = order.totals.amountPaid.isPositive;
    const next: Order = this.mutate(order, {
      status: 'cancelled',
      paymentStatus: refundRequired ? order.paymentStatus : 'failed',
      cancelledAt: this.clock.now().toISOString(),
    });
    return await this.repository.save(
      this.withEvent(next, 'order.cancelled', input.actor.id, reason),
      order.version,
    );
  }

  public async refund(input: RefundInput): Promise<Order> {
    const order: Order = await this.load(input.orderId);
    assertActiveAccount(input.actor);
    assertPermission(input.actor, 'payment.refund.any', 'refund');
    this.checkVersion(order, input.expectedVersion);
    if (!canTransition(order.status, 'refunded')) {
      throw new InvalidStateError('Order', order.status, 'refunded', 'this order state cannot be refunded');
    }
    if (input.amount.currency !== order.currency) throw ValidationError.field('amount', `Refund must be in ${order.currency}`);
    input.amount.assertNonNegative('amount');
    const refundable: Money = order.totals.amountPaid.subtract(order.totals.amountRefunded);
    if (input.amount.greaterThan(refundable)) {
      throw new ConflictError(`Refund exceeds the refundable amount (${refundable.format()})`, {
        refundableMinor: refundable.minorUnits,
        requestedMinor: input.amount.minorUnits,
      });
    }
    const amountRefunded: Money = order.totals.amountRefunded.add(input.amount);
    const totals = recomputeOrderTotals({
      currency: order.currency,
      itemsTotal: order.totals.itemsTotal,
      discountTotal: order.totals.discountTotal,
      shippingTotal: order.totals.shippingTotal,
      taxTotal: order.totals.taxTotal,
      serviceFeeTotal: order.totals.serviceFeeTotal,
      amountPaid: order.totals.amountPaid,
      amountRefunded,
    });
    const fully: boolean = amountRefunded.equals(order.totals.amountPaid);
    const next: Order = this.mutate(order, {
      status: 'refunded',
      paymentStatus: fully ? 'refunded' : 'partially_refunded',
      totals: Object.freeze(totals),
    });
    return await this.repository.save(
      this.withEvent(next, 'order.refunded', input.actor.id, `${input.amount.format()} — ${input.reason}`),
      order.version,
    );
  }

  /* -------------------------------- reads -------------------------------- */

  public async load(orderId: string): Promise<Order> {
    if (typeof orderId !== 'string' || orderId.trim().length === 0) {
      throw ValidationError.field('orderId', 'Order id is required');
    }
    const order: Order | undefined = await this.repository.load(orderId);
    if (order === undefined) throw new NotFoundError('Order', orderId);
    return order;
  }

  public async view(orderId: string, actor: User): Promise<Order> {
    return await this.requireReadable(orderId, actor);
  }

  public async list(query: OrderQuery): Promise<readonly Order[]> {
    const limit: number = positiveInteger(1)(Math.min(query.limit ?? 50, 200));
    const offset: number = query.offset === undefined ? 0 : positiveInteger(0)(query.offset);
    const source: readonly Order[] = await this.allOrders();
    const filtered: Order[] = source.filter((order: Order) => {
      if (query.buyerId !== undefined && order.buyerId !== query.buyerId) return false;
      if (query.sellerId !== undefined && !order.sellerIds.includes(query.sellerId)) return false;
      if (query.status !== undefined && order.status !== query.status) return false;
      return true;
    });
    filtered.sort((a: Order, b: Order) => b.createdAt.localeCompare(a.createdAt) || a.number.localeCompare(b.number));
    return Object.freeze(filtered.slice(offset, offset + limit));
  }

  /** Sellers see their own rows; buyers see theirs; admins see everything. */
  public async listForActor(actor: User, query: OrderQuery): Promise<readonly Order[]> {
    assertActiveAccount(actor);
    if (actor.role === 'admin') return await this.list(query);
    const scoped: OrderQuery =
      actor.role === 'buyer' ? { ...query, buyerId: actor.id } : { ...query, sellerId: actor.id };
    return await this.list(scoped);
  }

  public async canTransitionFrom(orderId: string): Promise<readonly OrderStatus[]> {
    const order: Order = await this.load(orderId);
    return allowedTransitions(order.status);
  }

  public isClosed(order: Order): boolean {
    return isClosed(order);
  }

  /* ------------------------------ internals ------------------------------ */

  private async allOrders(): Promise<readonly Order[]> {
    // The port contract guarantees `load`; repositories expose listing through
    // an optional extension so adapters stay minimal.
    const candidate = this.repository as Partial<{ loadAll(): Promise<readonly Order[]> }>;
    if (typeof candidate.loadAll === 'function') return await candidate.loadAll();
    return Object.freeze([]);
  }

  private assertIdempotencyKey(key: unknown): string {
    if (typeof key !== 'string' || !IDEMPOTENCY_PATTERN.test(key)) {
      throw ValidationError.field('idempotencyKey', 'Use 8-128 URL-safe characters for the idempotency key');
    }
    return key;
  }

  private checkVersion(order: Order, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && expectedVersion !== order.version) {
      throw new ConflictError(`Order '${order.id}' changed; reload before retrying`, {
        orderId: order.id,
        expectedVersion,
        actualVersion: order.version,
      });
    }
  }

  private async requireReadable(orderId: string, actor: User): Promise<Order> {
    assertActiveAccount(actor);
    const order: Order = await this.load(orderId);
    const verdict = evaluatePolicy(actor, { buyerId: order.buyerId, sellerIds: order.sellerIds }, orderParticipationPolicy);
    if (!verdict.allowed) throw new UnauthorizedError(verdict.reason, { orderId });
    return order;
  }

  private async requireSellerOf(orderId: string, actor: User): Promise<Order> {
    assertActiveAccount(actor);
    const order: Order = await this.load(orderId);
    if (actor.role !== 'admin' && !order.sellerIds.includes(actor.id)) {
      throw new UnauthorizedError('Only a participating seller or an admin can modify this order', { orderId });
    }
    return order;
  }

  private mutate(order: Order, patch: Partial<Omit<Order, 'id' | 'version'>>): Order {
    return Object.freeze({
      ...order,
      ...patch,
      status: patch.status ?? order.status,
      paymentStatus: patch.paymentStatus ?? PAYMENT_BY_ORDER_STATUS[patch.status ?? order.status] ?? order.paymentStatus,
      version: order.version + 1,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  private withEvent(order: Order, type: string, actorId: string, note?: string): Order {
    const event: TimelineEvent = Object.freeze({ at: this.clock.now().toISOString(), type, actorId, note });
    return Object.freeze({ ...order, timeline: Object.freeze([...order.timeline, event]) });
  }

  private resolveLineQuantities(
    order: Order,
    lines: readonly { readonly skuId: string; readonly quantity: number }[],
  ): Map<string, number> {
    if (!Array.isArray(lines) || lines.length === 0) {
      // Default: everything that has not been handled yet.
      const auto = new Map<string, number>();
      for (const item of order.items) {
        const remaining: number = item.quantity - item.fulfilledQuantity;
        if (remaining > 0) auto.set(item.snapshot.skuId, remaining);
      }
      return auto;
    }
    const known = new Map(order.items.map((item: OrderItem) => [item.snapshot.skuId, item]));
    const deltas = new Map<string, number>();
    for (const line of lines) {
      const item = known.get(line.skuId);
      if (item === undefined) throw new ValidationError(`SKU '${line.skuId}' is not part of this order`);
      const quantity: number = positiveInteger()(line.quantity);
      deltas.set(line.skuId, (deltas.get(line.skuId) ?? 0) + quantity);
    }
    return deltas;
  }

  private async resolveAddress(actor: User, addressId: string): Promise<Address> {
    const parsed: string = identifier(addressId);
    const address: Address | undefined = findAddress(actor, parsed);
    if (address === undefined) throw new NotFoundError('Address', parsed);
    if (!/^[A-Z]{2}$/.test(address.country)) {
      throw ValidationError.field('country', 'Address country must be an ISO 3166-1 alpha-2 code');
    }
    return address;
  }

  private resolveShippingMethod(code: string, address: Address): ShippingMethod {
    const methods: readonly ShippingMethod[] = this.config.shippingMethods();
    const method: ShippingMethod | undefined = methods.find((candidate: ShippingMethod) => candidate.code === code);
    if (method === undefined) {
      throw new ValidationError(`Unknown shipping method '${code}'`, [{ field: 'shippingMethodCode', message: 'Not available' }]);
    }
    if (!method.availableCountries.includes(address.country)) {
      throw new ConflictError(`Shipping method '${method.name}' does not serve ${address.country}`, {
        methodCode: method.code,
        country: address.country,
      });
    }
    return method;
  }

  private async resolveCoupon(code: string | undefined): Promise<Coupon | undefined> {
    if (code === undefined) return undefined;
    if (this.coupons === undefined) return undefined;
    return await this.coupons.find(code);
  }

  private buildQuote(
    prepared: readonly { readonly sku: Sku; readonly quantity: number }[],
    currency: Currency,
    address: Address,
    method: ShippingMethod,
    coupon: Coupon | undefined,
    skusById: ReadonlyMap<string, Sku>,
  ): PriceQuote {
    const skuPricing = new Map<string, SkuPricing>();
    for (const [skuId, sku] of skusById) {
      skuPricing.set(skuId, {
        skuId,
        unitPrice: sku.unitPrice,
        weightGrams: sku.weightGrams,
        taxCode: sku.hsCode ?? 'default',
      });
    }
    return PricingEngine.quote({
      currency,
      buyer: { address },
      sellerIds: [...new Set(prepared.map((entry) => entry.sku.sellerId))],
      lines: prepared.map((entry) => ({ skuId: entry.sku.id, quantity: entry.quantity })),
      skus: skuPricing,
      coupon,
      shippingMethod: method,
      taxRules: this.config.taxRules(),
      serviceFeeBasisPoints: this.config.serviceFeeBasisPoints(),
    });
  }
}

function allComplete(items: readonly OrderItem[]): boolean {
  return items.every((item: OrderItem) => item.fulfilledQuantity >= item.quantity);
}

function describeDeltas(deltas: Map<string, number>): string {
  if (deltas.size === 0) return 'no lines';
  return [...deltas.entries()].map(([skuId, quantity]: [string, number]) => `${skuId}x${String(quantity)}`).join(', ');
}

/** Split a refund across order lines proportionally (used by support tooling). */
export function splitRefundAcrossLines(
  order: Order,
  amount: Money,
): readonly { readonly lineId: string; readonly amount: Money }[] {
  const weights: number[] = order.items.map((item: OrderItem) => item.netTotal.minorUnits);
  const shares: number[] = allocate(amount.minorUnits, weights);
  return Object.freeze(
    order.items.map((item: OrderItem, index: number) =>
      Object.freeze({ lineId: item.lineId, amount: Money.fromMinor(order.currency, shares[index] ?? 0) }),
    ),
  );
}

export { InsufficientStockError };
