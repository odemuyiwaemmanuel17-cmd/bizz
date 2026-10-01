/**
 * Shopping cart service (wholesale-aware).
 *
 * Invariants enforced here:
 *  - a cart is single-currency;
 *  - quantities respect MOQ + pack step and never exceed available stock;
 *  - unit prices are snapshotted per line, so later price changes surface as an
 *    explicit `priceChanged` notice instead of silently mutating the total;
 *  - every mutation bumps `version` so clients can detect lost updates.
 */

import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import type { Clock } from './id.js';
import { SequentialIdGenerator } from './id.js';
import { isCurrency, Money, type Currency } from './money.js';
import { PricingEngine, type Coupon, type PriceQuote, type ShippingMethod, type SkuPricing, type RateRule } from './pricing.js';
import { assertPermission } from './rbac.js';
import { identifier, positiveInteger } from './schema.js';
import type { Address, Cart, CartLine, Sku, User } from './types.js';
import { availableQuantity, defaultShippingAddress, findAddress, type StockRecord } from './types.js';

export interface CatalogPort {
  getSku(skuId: string): Promise<Sku | undefined>;
}

export interface StockPort {
  getStock(skuId: string): Promise<StockRecord | undefined>;
}

export interface CartRepository {
  load(cartId: string): Promise<Cart | undefined>;
  save(cart: Cart, expectedVersion: number): Promise<Cart>;
}

export interface CouponPort {
  find(code: string): Promise<Coupon | undefined>;
}

export interface PricingPorts {
  shippingMethods(): readonly ShippingMethod[];
  taxRules(): readonly RateRule[];
  serviceFeeBasisPoints(): number;
}

export class InMemoryCartRepository implements CartRepository {
  private readonly carts: Map<string, Cart> = new Map();

  public async load(cartId: string): Promise<Cart | undefined> {
    const found: Cart | undefined = this.carts.get(cartId);
    return found === undefined ? undefined : found;
  }

  public async save(cart: Cart, expectedVersion: number): Promise<Cart> {
    const current: Cart | undefined = this.carts.get(cart.id);
    if (current === undefined && expectedVersion !== 0) {
      throw new ConflictError(`Cart '${cart.id}' no longer exists`, { cartId: cart.id });
    }
    if (current !== undefined && current.version !== expectedVersion) {
      throw new ConflictError(`Cart '${cart.id}' was modified concurrently`, {
        cartId: cart.id,
        expectedVersion,
        actualVersion: current.version,
      });
    }
    const frozen: Cart = Object.freeze({ ...cart, lines: Object.freeze([...cart.lines]) });
    this.carts.set(cart.id, frozen);
    return frozen;
  }
}

export interface CreateCartInput {
  readonly buyerId: string;
  readonly currency: Currency;
  readonly shippingAddressId?: string;
}

export interface AddLineInput {
  readonly cartId: string;
  readonly skuId: string;
  readonly quantity: number;
  readonly actor: User;
  readonly expectedVersion?: number;
}

export interface ChangeQuantityInput {
  readonly cartId: string;
  readonly skuId: string;
  readonly quantity: number;
  readonly actor: User;
  readonly expectedVersion?: number;
}

export interface RemoveLineInput {
  readonly cartId: string;
  readonly skuId: string;
  readonly actor: User;
  readonly expectedVersion?: number;
}

export interface ApplyCouponInput {
  readonly cartId: string;
  readonly code: string;
  readonly actor: User;
  readonly expectedVersion?: number;
}

export interface SetAddressInput {
  readonly cartId: string;
  readonly addressId: string;
  readonly actor: User;
  readonly expectedVersion?: number;
}

export interface LineNotice {
  readonly skuId: string;
  readonly kind: 'price_changed' | 'out_of_stock' | 'reduced_quantity' | 'unpublished' | 'missing_stock';
  readonly message: string;
  readonly previousUnitPrice?: Money;
  readonly currentUnitPrice?: Money;
  readonly requestedQuantity?: number;
  readonly availableQuantity?: number;
}

export interface CartView {
  readonly cart: Cart;
  readonly quote: PriceQuote;
  readonly notices: readonly LineNotice[];
  readonly itemCount: number;
  readonly unitCount: number;
  readonly checkoutReady: boolean;
  readonly blockingReasons: readonly string[];
}

export interface CartServiceOptions {
  readonly catalog: CatalogPort;
  readonly stock: StockPort;
  readonly repository: CartRepository;
  readonly coupons?: CouponPort;
  readonly pricing: PricingPorts;
  readonly clock: Clock;
  readonly idGenerator?: SequentialIdGenerator;
  readonly maxLines?: number;
  readonly maxQuantityPerLine?: number;
}

const DEFAULT_MAX_LINES = 100;
const DEFAULT_MAX_QUANTITY = 100_000;

export class CartService {
  private readonly catalog: CatalogPort;
  private readonly stock: StockPort;
  private readonly repository: CartRepository;
  private readonly coupons: CouponPort | undefined;
  private readonly pricing: PricingPorts;
  private readonly clock: Clock;
  private readonly ids: SequentialIdGenerator;
  private readonly maxLines: number;
  private readonly maxQuantityPerLine: number;

  public constructor(options: CartServiceOptions) {
    if (options.catalog === undefined) throw ValidationError.field('catalog', 'A catalog port is required');
    if (options.stock === undefined) throw ValidationError.field('stock', 'A stock port is required');
    if (options.repository === undefined) throw ValidationError.field('repository', 'A cart repository is required');
    if (options.pricing === undefined) throw ValidationError.field('pricing', 'Pricing configuration is required');
    if (options.clock === undefined) throw ValidationError.field('clock', 'A clock is required');
    this.catalog = options.catalog;
    this.stock = options.stock;
    this.repository = options.repository;
    this.coupons = options.coupons;
    this.pricing = options.pricing;
    this.clock = options.clock;
    this.ids = options.idGenerator ?? new SequentialIdGenerator('cart');
    this.maxLines = positiveInteger(1)(options.maxLines ?? DEFAULT_MAX_LINES);
    this.maxQuantityPerLine = positiveInteger(1)(options.maxQuantityPerLine ?? DEFAULT_MAX_QUANTITY);
  }

  /* ------------------------------- lifecycle ----------------------------- */

  public async create(input: CreateCartInput): Promise<Cart> {
    const buyerId: string = identifier(input.buyerId);
    if (!isCurrency(input.currency)) {
      throw ValidationError.field('currency', `Unsupported currency '${String(input.currency)}'`);
    }
    const now: string = this.clock.now().toISOString();
    const cart: Cart = Object.freeze({
      id: this.ids.next('crt'),
      buyerId,
      currency: input.currency,
      lines: Object.freeze([]) as readonly CartLine[],
      shippingAddressId: input.shippingAddressId,
      updatedAt: now,
      version: 1,
    });
    return await this.repository.save(cart, 0);
  }

  public async get(cartId: string): Promise<Cart> {
    const cart: Cart | undefined = await this.load(cartId);
    if (cart === undefined) throw new NotFoundError('Cart', cartId);
    return cart;
  }

  /** Buyers may only touch their own carts; admins may act on any cart. */
  public async getForActor(cartId: string, actor: User): Promise<Cart> {
    const cart: Cart = await this.get(cartId);
    assertPermission(actor, 'order.create', 'cart');
    if (actor.role !== 'admin' && cart.buyerId !== actor.id) {
      throw new ConflictError('Cart belongs to another buyer', { cartId });
    }
    return cart;
  }

  public async clear(input: { cartId: string; actor: User; expectedVersion?: number }): Promise<Cart> {
    const cart: Cart = await this.getForActor(input.cartId, input.actor);
    this.requireVersion(cart, input.expectedVersion);
    return await this.persist({ ...cart, lines: [], couponCode: undefined }, cart.version);
  }

  /* --------------------------------- lines ------------------------------- */

  public async addLine(input: AddLineInput): Promise<Cart> {
    const cart: Cart = await this.getForActor(input.cartId, input.actor);
    this.requireVersion(cart, input.expectedVersion);
    const sku: Sku = await this.requirePurchasableSku(input.skuId, input.quantity);
    if (sku.unitPrice.currency !== cart.currency) {
      throw new ValidationError(
        `SKU '${sku.skuCode}' is priced in ${sku.unitPrice.currency} but this cart is in ${cart.currency}`,
        [{ field: 'currency', message: `Expected ${cart.currency}` }],
        { skuId: sku.id, skuCurrency: sku.unitPrice.currency, cartCurrency: cart.currency },
      );
    }
    const existingIndex: number = cart.lines.findIndex((line: CartLine) => line.skuId === sku.id);
    const targetQuantity: number = (existingIndex >= 0 ? (cart.lines[existingIndex] as CartLine).quantity : 0) + input.quantity;
    this.assertStepAndMin(sku, targetQuantity);
    await this.assertAvailability(sku, targetQuantity);

    let lines: CartLine[];
    if (existingIndex >= 0) {
      lines = cart.lines.map((line: CartLine, index: number): CartLine =>
        index === existingIndex ? Object.freeze({ ...line, quantity: targetQuantity }) : line,
      );
    } else {
      if (cart.lines.length >= this.maxLines) {
        throw new ConflictError(`Cart is limited to ${String(this.maxLines)} distinct SKUs`, { cartId: cart.id });
      }
      lines = [
        ...cart.lines,
        Object.freeze({
          skuId: sku.id,
          sellerId: sku.sellerId,
          quantity: input.quantity,
          unitPrice: sku.unitPrice,
          addedAt: this.clock.now().toISOString(),
        }),
      ];
    }
    return await this.persist({ ...cart, lines }, cart.version);
  }

  public async changeQuantity(input: ChangeQuantityInput): Promise<Cart> {
    const cart: Cart = await this.getForActor(input.cartId, input.actor);
    this.requireVersion(cart, input.expectedVersion);
    const index: number = cart.lines.findIndex((line: CartLine) => line.skuId === input.skuId);
    if (index < 0) throw new NotFoundError('Cart line', input.skuId);
    if (input.quantity <= 0) return await this.removeLine({ ...input, quantity: 0 });

    const sku: Sku = await this.requirePurchasableSku(input.skuId, input.quantity);
    this.assertStepAndMin(sku, input.quantity);
    await this.assertAvailability(sku, input.quantity);

    const lines: CartLine[] = cart.lines.map((line: CartLine, position: number): CartLine =>
      position === index
        ? Object.freeze({ ...line, quantity: input.quantity, unitPrice: sku.unitPrice })
        : line,
    );
    return await this.persist({ ...cart, lines }, cart.version);
  }

  public async removeLine(input: RemoveLineInput): Promise<Cart> {
    const cart: Cart = await this.getForActor(input.cartId, input.actor);
    this.requireVersion(cart, input.expectedVersion);
    const lines: CartLine[] = cart.lines.filter((line: CartLine) => line.skuId !== input.skuId);
    if (lines.length === cart.lines.length) throw new NotFoundError('Cart line', input.skuId);
    return await this.persist({ ...cart, lines }, cart.version);
  }

  /** `POST /api/votes` backing call: upserts a buyer's quantity on one SKU. */
  public async setVoteQuantity(input: { readonly cartId: string; readonly actor: User; readonly skuId: number | string; readonly quantity: number }): Promise<Cart> {
    const skuId: string = String(input.skuId);
    if (input.quantity <= 0) {
      try {
        return await this.removeLine({ cartId: input.cartId, actor: input.actor, skuId });
      } catch (error: unknown) {
        if (error instanceof NotFoundError) {
          // No prior vote — create an empty cart so the zero state is representable.
          const created: Cart = await this.createCart({ actor: input.actor });
          return created;
        }
        throw error;
      }
    }
    return await this.addLine({ cartId: input.cartId, actor: input.actor, skuId, quantity: input.quantity });
  }

  /* -------------------------- address & coupons -------------------------- */

  public async setShippingAddress(input: SetAddressInput): Promise<Cart> {
    const cart: Cart = await this.getForActor(input.cartId, input.actor);
    this.requireVersion(cart, input.expectedVersion);
    const address: Address | undefined = findAddress(input.actor, input.addressId);
    if (address === undefined) throw new NotFoundError('Address', input.addressId);
    return await this.persist({ ...cart, shippingAddressId: address.id }, cart.version);
  }

  public async applyCoupon(input: ApplyCouponInput): Promise<Cart> {
    const cart: Cart = await this.getForActor(input.cartId, input.actor);
    this.requireVersion(cart, input.expectedVersion);
    const code: string = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
    if (code.length === 0) throw ValidationError.field('code', 'Coupon code is required');
    if (this.coupons === undefined) {
      throw new ConflictError('Coupons are not configured for this marketplace', { code });
    }
    const coupon: Coupon | undefined = await this.coupons.find(code);
    if (coupon === undefined) throw new NotFoundError('Coupon', code);
    // Fail fast with a clear message rather than silently ignoring the coupon.
    const probe: PriceQuote = await this.quoteCart(cart, coupon);
    if (!probe.couponApplied) {
      throw new ConflictError(probe.couponRejectedReason ?? `Coupon '${code}' cannot be applied to this cart`, {
        code,
      });
    }
    return await this.persist({ ...cart, couponCode: coupon.code }, cart.version);
  }

  public async removeCoupon(input: { cartId: string; actor: User; expectedVersion?: number }): Promise<Cart> {
    const cart: Cart = await this.getForActor(input.cartId, input.actor);
    this.requireVersion(cart, input.expectedVersion);
    const { couponCode: _ignored, ...rest }: Cart = cart;
    void _ignored;
    return await this.persist(rest, cart.version);
  }

  /* -------------------------------- quoting ------------------------------ */

  public async view(cartId: string, actor: User): Promise<CartView> {
    const cart: Cart = await this.getForActor(cartId, actor);
    return await this.buildView(cart);
  }

  public async buildView(cart: Cart): Promise<CartView> {
    const notices: LineNotice[] = [];
    const skusById = new Map<string, Sku>();

    for (const line of cart.lines) {
      const sku: Sku | undefined = await this.catalog.getSku(line.skuId);
      if (sku === undefined) {
        notices.push({ skuId: line.skuId, kind: 'unpublished', message: `SKU '${line.skuId}' is no longer listed` });
        continue;
      }
      skusById.set(sku.id, sku);
      if (!sku.unitPrice.equals(line.unitPrice)) {
        notices.push({
          skuId: sku.id,
          kind: 'price_changed',
          message: `Price changed from ${line.unitPrice.format()} to ${sku.unitPrice.format()}`,
          previousUnitPrice: line.unitPrice,
          currentUnitPrice: sku.unitPrice,
        });
      }
      const stock: StockRecord | undefined = await this.stock.getStock(sku.id);
      if (stock === undefined) {
        notices.push({ skuId: sku.id, kind: 'missing_stock', message: `No inventory record for SKU '${sku.skuCode}'` });
        continue;
      }
      const available: number = availableQuantity(stock);
      if (available <= 0) {
        notices.push({ skuId: sku.id, kind: 'out_of_stock', message: `'${sku.skuCode}' is out of stock`, availableQuantity: 0, requestedQuantity: line.quantity });
      } else if (available < line.quantity) {
        notices.push({
          skuId: sku.id,
          kind: 'reduced_quantity',
          message: `Only ${String(available)} unit(s) of '${sku.skuCode}' remain`,
          availableQuantity: available,
          requestedQuantity: line.quantity,
        });
      }
    }

    const quote: PriceQuote = await this.quoteCart(cart, undefined, skusById);
    const blockingReasons: string[] = [];
    if (cart.lines.length === 0) blockingReasons.push('Your cart is empty');
    if (cart.shippingAddressId === undefined) blockingReasons.push('Select a shipping address');
    for (const notice of notices) {
      if (notice.kind === 'out_of_stock' || notice.kind === 'unpublished' || notice.kind === 'missing_stock') {
        blockingReasons.push(notice.message);
      }
    }
    const unitCount: number = cart.lines.reduce((sum: number, line: CartLine) => sum + line.quantity, 0);
    return Object.freeze({
      cart,
      quote,
      notices: Object.freeze(notices),
      itemCount: cart.lines.length,
      unitCount,
      checkoutReady: blockingReasons.length === 0,
      blockingReasons: Object.freeze(blockingReasons),
    });
  }

  private async quoteCart(cart: Cart, couponOverride?: Coupon, skusById?: ReadonlyMap<string, Sku>): Promise<PriceQuote> {
    const skuMap = new Map<string, SkuPricing>();
    const sellerIds = new Set<string>();
    for (const line of cart.lines) {
      const sku: Sku | undefined = skusById?.get(line.skuId) ?? (await this.catalog.getSku(line.skuId));
      if (sku === undefined) continue;
      sellerIds.add(sku.sellerId);
      skuMap.set(sku.id, {
        skuId: sku.id,
        unitPrice: sku.unitPrice,
        weightGrams: sku.weightGrams,
        taxCode: sku.hsCode ?? 'default',
      });
    }
    const buyer: { address: Address } = { address: this.placeholderAddress(cart.currency) };
    const coupon: Coupon | undefined = couponOverride ?? (await this.resolveCoupon(cart.couponCode));
    return PricingEngine.quote({
      currency: cart.currency,
      buyer,
      sellerIds: [...sellerIds],
      lines: cart.lines.map((line: CartLine) => ({ skuId: line.skuId, quantity: line.quantity })),
      skus: skuMap,
      coupon,
      shippingMethod: undefined,
      taxRules: this.pricing.taxRules(),
      serviceFeeBasisPoints: this.pricing.serviceFeeBasisPoints(),
    });
  }

  private async resolveCoupon(code: string | undefined): Promise<Coupon | undefined> {
    if (code === undefined || this.coupons === undefined) return undefined;
    try {
      return await this.coupons.find(code);
    } catch {
      // A flaky coupon service must never break cart rendering.
      return undefined;
    }
  }

  /** Placeholder used while no address has been chosen; taxes recompute at checkout. */
  private placeholderAddress(currency: Currency): Address {
    return Object.freeze({
      id: 'addr_placeholder',
      label: 'pending',
      fullName: 'Pending selection',
      line1: 'Pending selection',
      city: 'Unknown',
      region: 'Unknown',
      country: currencyToCountry(currency),
      postalCode: '00000',
    });
  }

  /* -------------------------------- helpers ------------------------------ */

  private async load(cartId: string): Promise<Cart | undefined> {
    if (typeof cartId !== 'string' || cartId.trim().length === 0) {
      throw ValidationError.field('cartId', 'Cart id is required');
    }
    return await this.repository.load(cartId);
  }

  private requireVersion(cart: Cart, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && expectedVersion !== cart.version) {
      throw new ConflictError(`Cart '${cart.id}' changed; reload before retrying`, {
        cartId: cart.id,
        expectedVersion,
        actualVersion: cart.version,
      });
    }
  }

  private async persist(cart: Cart, expectedVersion: number): Promise<Cart> {
    const next: Cart = Object.freeze({
      ...cart,
      lines: Object.freeze([...cart.lines]),
      version: expectedVersion + 1,
      updatedAt: this.clock.now().toISOString(),
    });
    return await this.repository.save(next, expectedVersion);
  }

  private async requirePurchasableSku(skuId: string, quantity: number): Promise<Sku> {
    const parsedQuantity: number = positiveInteger(1)(quantity);
    if (parsedQuantity > this.maxQuantityPerLine) {
      throw ValidationError.field('quantity', `A single line cannot exceed ${String(this.maxQuantityPerLine)} units`);
    }
    const sku: Sku | undefined = await this.catalog.getSku(skuId);
    if (sku === undefined) throw new NotFoundError('Sku', skuId);
    if (sku.status !== 'published') {
      throw new ConflictError(`SKU '${sku.skuCode}' is not available for purchase`, { skuId, status: sku.status });
    }
    return sku;
  }

  private assertStepAndMin(sku: Sku, quantity: number): void {
    if (quantity < sku.minOrderQuantity) {
      throw ValidationError.field(
        'quantity',
        `Minimum order quantity for '${sku.skuCode}' is ${String(sku.minOrderQuantity)}`,
      );
    }
    if (sku.quantityStep > 1 && quantity % sku.quantityStep !== 0) {
      throw ValidationError.field('quantity', `Quantity for '${sku.skuCode}' must be a multiple of ${String(sku.quantityStep)}`);
    }
  }

  private async assertAvailability(sku: Sku, quantity: number): Promise<void> {
    const stock: StockRecord | undefined = await this.stock.getStock(sku.id);
    if (stock === undefined) {
      throw new ConflictError(`SKU '${sku.skuCode}' cannot be purchased right now: inventory unavailable`, { skuId: sku.id });
    }
    const available: number = availableQuantity(stock);
    if (available < quantity) {
      throw new ValidationError(
        `Only ${String(available)} unit(s) of '${sku.skuCode}' are available`,
        [{ field: 'quantity', message: `Requested ${String(quantity)}, available ${String(available)}` }],
        { skuId: sku.id, available, requested: quantity },
      );
    }
  }
}

function currencyToCountry(currency: Currency): string {
  switch (currency) {
    case 'USD':
      return 'US';
    case 'EUR':
      return 'DE';
    case 'GBP':
      return 'GB';
    case 'NGN':
      return 'NG';
    default:
      return 'US';
  }
}

/** Re-exported so callers can hydrate a cart without importing `types` directly. */
export { defaultShippingAddress };
