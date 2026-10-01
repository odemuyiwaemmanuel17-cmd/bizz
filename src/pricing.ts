/**
 * Pricing engine: pure, deterministic and side-effect free.
 *
 * Order of evaluation is fixed and documented:
 *   1. line subtotal      = unit price x quantity (integer minor units)
 *   2. tier discounts     (per SKU, applied to the line)
 *   3. coupon / promo     (order level, allocated across lines by value weight)
 *   4. shipping           (free-threshold on discounted merchandise total)
 *   5. tax                (line-level rounding, then summed — avoids penny drift)
 *   6. marketplace service fee
 *   7. grand total & balance due
 *
 * Because every step returns a new `Money`, the same input always produces the
 * byte-identical output — which is what makes idempotency hashing safe.
 */

import { Money, type Currency } from './money.js';
import { ValidationError } from './errors.js';
import type { Address } from './types.js';

export interface TierRule {
  readonly minQuantity: number;
  /** Discount expressed in basis points off the list price (500 = 5%). */
  readonly basisPoints: number;
}

export interface SkuPricing {
  readonly skuId: string;
  readonly unitPrice: Money;
  readonly tiers?: readonly TierRule[];
  /** Tax category code, resolved through the tax table. */
  readonly taxCode?: string;
  readonly weightGrams?: number;
}

export interface PricingLineInput {
  readonly skuId: string;
  readonly quantity: number;
  /** Overrides the catalog unit price (quote-based B2B deals). */
  readonly unitPriceOverride?: Money;
}

export interface Coupon {
  readonly code: string;
  readonly kind: 'percentage' | 'fixed_amount' | 'free_shipping';
  readonly basisPoints?: number;
  readonly amount?: Money;
  readonly minimumSubtotal?: Money;
  readonly maxDiscount?: Money;
  readonly appliesToSellerIds?: readonly string[];
  readonly stackable?: boolean;
}

export interface ShippingMethod {
  readonly code: string;
  readonly name: string;
  readonly baseCost: Money;
  /** Per-kilogram surcharge in minor units per 1000 grams. */
  readonly perKgMinorUnits: number;
  readonly freeOver?: Money;
  readonly availableCountries: readonly string[];
}

export interface RateRule {
  readonly country: string;
  readonly region?: string;
  readonly taxCode: string;
  readonly basisPoints: number;
  readonly label: string;
}

export interface PricingContext {
  readonly currency: Currency;
  readonly buyer: { readonly address: Address };
  readonly sellerIds: readonly string[];
  readonly lines: readonly PricingLineInput[];
  readonly skus: ReadonlyMap<string, SkuPricing>;
  readonly coupon?: Coupon;
  readonly shippingMethod?: ShippingMethod;
  readonly taxRules?: readonly RateRule[];
  /** Marketplace take-rate in basis points (250 = 2.5%). */
  readonly serviceFeeBasisPoints?: number;
  readonly roundTaxPerLine?: boolean;
}

export interface PricedLine {
  readonly skuId: string;
  readonly quantity: number;
  readonly unitListPrice: Money;
  readonly effectiveUnitPrice: Money;
  readonly grossAmount: Money;
  readonly tierDiscount: Money;
  readonly couponDiscount: Money;
  readonly discountTotal: Money;
  readonly netAmount: Money;
  readonly taxableAmount: Money;
  readonly taxAmount: Money;
  readonly lineTotal: Money;
  readonly appliedTier?: TierRule;
}

export interface PriceQuote {
  readonly currency: Currency;
  readonly lines: readonly PricedLine[];
  readonly itemsTotal: Money;
  readonly tierDiscountTotal: Money;
  readonly couponDiscountTotal: Money;
  readonly discountTotal: Money;
  readonly shippingTotal: Money;
  readonly taxTotal: Money;
  readonly serviceFeeTotal: Money;
  readonly grandTotal: Money;
  readonly couponApplied: boolean;
  readonly couponRejectedReason?: string;
  readonly freeShippingApplied: boolean;
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function money(currency: Currency, minor: number): Money {
  return Money.fromMinor(currency, minor);
}

function resolveSku(context: PricingContext, skuId: string): SkuPricing {
  const sku: SkuPricing | undefined = context.skus.get(skuId);
  if (sku === undefined) {
    throw new ValidationError(`Unknown SKU '${skuId}' in pricing context`, [{ field: 'skus', message: `'${skuId}' not found` }]);
  }
  return sku;
}

/** Best (largest) tier whose MOQ the quantity satisfies. */
export function findTier(tiers: readonly TierRule[] | undefined, quantity: number): TierRule | undefined {
  if (tiers === undefined || tiers.length === 0) return undefined;
  let best: TierRule | undefined;
  for (const tier of tiers) {
    if (!Number.isInteger(tier.minQuantity) || tier.minQuantity < 1) {
      throw ValidationError.field('tiers', 'Tier minQuantity must be a positive integer');
    }
    if (tier.basisPoints < 0 || tier.basisPoints > 10_000) {
      throw ValidationError.field('tiers', 'Tier basisPoints must be between 0 and 10000');
    }
    if (quantity >= tier.minQuantity) {
      if (best === undefined || tier.minQuantity > best.minQuantity || (tier.minQuantity === best.minQuantity && tier.basisPoints > best.basisPoints)) {
        best = tier;
      }
    }
  }
  return best;
}

export function effectiveUnitPrice(listPrice: Money, tier: TierRule | undefined): Money {
  if (tier === undefined) return listPrice;
  return money(listPrice.currency, Math.trunc((listPrice.amount * (10_000 - tier.basisPoints)) / 10_000));
}

/** Round-half-up of `value` divided by `divisor`, entirely in integers. */
function mulDivRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new ValidationError('Division by zero while pricing');
  const negative: boolean = numerator < 0 !== denominator < 0;
  const absNumerator = Math.abs(numerator);
  const absDenominator = Math.abs(denominator);
  const quotient = Math.floor(absNumerator / absDenominator);
  const remainder = absNumerator - quotient * absDenominator;
  const rounded = remainder * 2 >= absDenominator ? quotient + 1 : quotient;
  return negative ? -rounded : rounded;
}

export function taxRateFor(rules: readonly RateRule[] | undefined, address: Address, taxCode: string): number {
  if (rules === undefined || rules.length === 0) return 0;
  const exactRegion = rules.find(
    (rule: RateRule) => rule.country === address.country && rule.region === address.region && rule.taxCode === taxCode,
  );
  if (exactRegion !== undefined) return exactRegion.basisPoints;
  const countryLevel = rules.filter((rule: RateRule) => rule.country === address.country && rule.taxCode === taxCode);
  const fallback = countryLevel.find((rule: RateRule) => rule.region === undefined);
  if (fallback !== undefined) return fallback.basisPoints;
  if (countryLevel.length > 0) return countryLevel[0]?.basisPoints ?? 0;
  return 0;
}

export function shippingCostFor(method: ShippingMethod, weightGrams: number, merchandiseTotal: Money): { readonly cost: Money; readonly free: boolean } {
  const threshold: Money | undefined = method.freeOver;
  if (threshold !== undefined && merchandiseTotal.atLeast(threshold)) {
    return { cost: money(method.baseCost.currency, 0), free: true };
  }
  const surcharge: number = mulDivRound(Math.max(0, weightGrams) * method.perKgMinorUnits, 1_000);
  return { cost: money(method.baseCost.currency, method.baseCost.amount + surcharge), free: false };
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

export class PricingEngine {
  private readonly context: PricingContext;
  private readonly warnings: string[] = [];

  public constructor(context: PricingContext) {
    this.context = context;
    this.warnings = [];
  }

  public static quote(context: PricingContext): PriceQuote {
    return new PricingEngine(context).quote();
  }

  public quote(): PriceQuote {
    const currency: Currency = this.context.currency;
    this.validateContext();

    /* 1 + 2: gross amounts and tier discounts. */
    interface Draft {
      readonly skuId: string;
      readonly quantity: number;
      readonly list: Money;
      readonly effective: Money;
      readonly gross: Money;
      readonly tierDiscount: Money;
      readonly tier?: TierRule;
      readonly taxCode: string;
      readonly weightGrams: number;
    }

    const drafts: Draft[] = this.context.lines.map((line: PricingLineInput) => {
      const sku: SkuPricing = resolveSku(this.context, line.skuId);
      const quantity: number = this.assertQuantity(line.quantity, line.skuId);
      const list: Money = line.unitPriceOverride ?? sku.unitPrice;
      if (list.currency !== currency) {
        throw new ValidationError(`Currency mismatch on '${line.skuId}'`, [
          { field: 'currency', message: `Expected ${currency}, received ${list.currency}` },
        ]);
      }
      const tier: TierRule | undefined = findTier(sku.tiers, quantity);
      const effective: Money = effectiveUnitPrice(list, tier);
      const gross: Money = money(currency, list.amount * quantity);
      const net: Money = money(currency, effective.amount * quantity);
      return {
        skuId: line.skuId,
        quantity,
        list,
        effective,
        gross,
        tierDiscount: gross.subtract(net),
        tier,
        taxCode: sku.taxCode ?? 'default',
        weightGrams: (sku.weightGrams ?? 0) * quantity,
      };
    });

    const itemsTotal: Money = Money.sum(drafts.map((draft: Draft) => draft.gross), currency);
    const tierDiscountTotal: Money = Money.sum(drafts.map((draft: Draft) => draft.tierDiscount), currency);

    /* 3: coupon. */
    const afterTier: Money = itemsTotal.subtract(tierDiscountTotal);
    const couponDecision = this.evaluateCoupon(afterTier);
    let couponDiscountTotal: Money = money(currency, 0);
    if (couponDecision.percentageBasisPoints > 0) {
      const raw: number = mulDivRound(afterTier.amount * couponDecision.percentageBasisPoints, 10_000);
      const capped: number =
        couponDecision.maxDiscount !== undefined && raw > couponDecision.maxDiscount.amount
          ? couponDecision.maxDiscount.amount
          : raw;
      couponDiscountTotal = money(currency, Math.max(0, capped));
    }
    if (couponDecision.fixedAmount !== null) couponDiscountTotal = couponDecision.fixedAmount;

    // Allocate the order-level coupon across lines proportionally to their net
    // value, using largest-remainder so the parts sum exactly to the whole.
    const lineNetValues: number[] = drafts.map((draft: Draft) => draft.gross.amount - draft.tierDiscount.amount);
    const allocations: number[] = allocate(couponDiscountTotal.amount, lineNetValues);

    /* 4: shipping. */
    const totalWeight: number = drafts.reduce((sum: number, draft: Draft) => sum + draft.weightGrams, 0);
    const discountedMerchandise: Money = afterTier.subtract(couponDiscountTotal);
    let shippingTotal: Money = money(currency, 0);
    let freeShippingApplied: boolean = false;
    const method: ShippingMethod | undefined = this.context.shippingMethod;
    if (method !== undefined) {
      if (!method.availableCountries.includes(this.context.buyer.address.country)) {
        this.warnings.push(`Shipping method '${method.code}' does not serve ${this.context.buyer.address.country}`);
        shippingTotal = money(currency, 0);
      } else {
        const computed = shippingCostFor(method, totalWeight, discountedMerchandise);
        shippingTotal = computed.cost;
        freeShippingApplied = computed.free;
        if (couponDecision.freeShipping) {
          shippingTotal = money(currency, 0);
          freeShippingApplied = true;
        }
      }
    } else if (couponDecision.freeShipping) {
      freeShippingApplied = true;
    }

    /* 5: tax (per line, then summed). */
    const roundPerLine: boolean = this.context.roundTaxPerLine ?? true;
    let taxTotal: Money = money(currency, 0);
    const pricedLines: PricedLine[] = drafts.map((draft: Draft, index: number) => {
      const netValue: number = lineNetValues[index] ?? 0;
      const couponPart: number = allocations[index] ?? 0;
      const taxable: Money = money(currency, Math.max(0, netValue - couponPart));
      const rate: number = taxRateFor(this.context.taxRules, this.context.buyer.address, draft.taxCode);
      let taxAmount: Money;
      if (roundPerLine) {
        taxAmount = money(currency, mulDivRound(taxable.amount * rate, 10_000));
      } else {
        taxAmount = taxable.multiply(rate / 10_000);
      }
      taxTotal = taxTotal.add(taxAmount);
      const discountTotal: Money = draft.tierDiscount.add(money(currency, couponPart));
      const netAmount: Money = draft.gross.subtract(discountTotal);
      return {
        skuId: draft.skuId,
        quantity: draft.quantity,
        unitListPrice: draft.list,
        effectiveUnitPrice: draft.effective,
        grossAmount: draft.gross,
        tierDiscount: draft.tierDiscount,
        couponDiscount: money(currency, couponPart),
        discountTotal,
        netAmount,
        taxableAmount: taxable,
        taxAmount,
        lineTotal: netAmount.add(taxAmount),
        appliedTier: draft.tier,
      };
    });

    /* 6: service fee on discounted merchandise (excludes shipping & tax). */
    const feeBasisPoints: number = this.context.serviceFeeBasisPoints ?? 0;
    const serviceFeeTotal: Money = money(
      currency,
      mulDivRound(Math.max(0, discountedMerchandise.amount) * feeBasisPoints, 10_000),
    );

    /* 7: totals. */
    const discountTotal: Money = tierDiscountTotal.add(couponDiscountTotal);
    const grandTotal: Money = discountedMerchandise.add(shippingTotal).add(taxTotal).add(serviceFeeTotal);

    return Object.freeze({
      currency,
      lines: Object.freeze(pricedLines),
      itemsTotal,
      tierDiscountTotal,
      couponDiscountTotal,
      discountTotal,
      shippingTotal,
      taxTotal,
      serviceFeeTotal,
      grandTotal,
      couponApplied: couponDecision.applied,
      couponRejectedReason: couponDecision.rejectedReason,
      freeShippingApplied,
      warnings: Object.freeze([...this.warnings]),
    });
  }

  /* ------------------------------ internals ------------------------------ */

  private validateContext(): void {
    const context: PricingContext = this.context;
    if (context.lines.length === 0) this.warnings.push('Cart contains no lines; quoting zero totals');
    for (const line of context.lines) {
      if (typeof line.skuId !== 'string' || line.skuId.length === 0) {
        throw ValidationError.field('lines', 'Every pricing line requires a skuId');
      }
    }
    const seen = new Set<string>();
    for (const line of context.lines) {
      if (seen.has(line.skuId)) this.warnings.push(`Duplicate line for SKU '${line.skuId}'`);
      seen.add(line.skuId);
    }
  }

  private assertQuantity(quantity: number, skuId: string): number {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new ValidationError(`Invalid quantity for '${skuId}'`, [
        { field: 'quantity', message: `Expected a positive integer, received '${String(quantity)}'` },
      ]);
    }
    return quantity;
  }

  private evaluateCoupon(merchandiseAfterTiers: Money): {
    readonly applied: boolean;
    readonly percentageBasisPoints: number;
    readonly fixedAmount: Money | null;
    readonly freeShipping: boolean;
    readonly maxDiscount: Money | undefined;
    readonly rejectedReason?: string;
  } {
    const currency: Currency = this.context.currency;
    const coupon: Coupon | undefined = this.context.coupon;
    const none = {
      applied: false,
      percentageBasisPoints: 0,
      fixedAmount: null,
      freeShipping: false,
      maxDiscount: undefined,
    } as const;
    if (coupon === undefined) return { ...none };

    if (coupon.appliesToSellerIds !== undefined && coupon.appliesToSellerIds.length > 0) {
      const eligible: boolean = this.context.sellerIds.some((sellerId: string) =>
        coupon.appliesToSellerIds?.includes(sellerId),
      );
      if (!eligible) {
        return { ...none, rejectedReason: `Coupon '${coupon.code}' is not valid for these sellers` };
      }
    }
    if (coupon.minimumSubtotal !== undefined && merchandiseAfterTiers.lessThan(coupon.minimumSubtotal)) {
      return {
        ...none,
        rejectedReason: `Coupon '${coupon.code}' requires a subtotal of at least ${coupon.minimumSubtotal.format()}`,
      };
    }
    if (coupon.kind === 'percentage') {
      const basisPoints: number | undefined = coupon.basisPoints;
      if (basisPoints === undefined || basisPoints < 0 || basisPoints > 10_000) {
        return { ...none, rejectedReason: `Coupon '${coupon.code}' has an invalid percentage` };
      }
      return {
        applied: true,
        percentageBasisPoints: basisPoints,
        fixedAmount: null,
        freeShipping: false,
        maxDiscount: coupon.maxDiscount,
      };
    }
    if (coupon.kind === 'fixed_amount') {
      const amount: Money | undefined = coupon.amount;
      if (amount === undefined || amount.currency !== currency) {
        return { ...none, rejectedReason: `Coupon '${coupon.code}' currency does not match the cart` };
      }
      const clamped: Money = amount.greaterThan(merchandiseAfterTiers) ? merchandiseAfterTiers : amount;
      return { applied: true, percentageBasisPoints: 0, fixedAmount: clamped, freeShipping: false, maxDiscount: undefined };
    }
    if (coupon.kind === 'free_shipping') {
      return { applied: true, percentageBasisPoints: 0, fixedAmount: null, freeShipping: true, maxDiscount: undefined };
    }
    return { ...none, rejectedReason: `Unsupported coupon kind '${String(coupon.kind)}'` };
  }
}

/**
 * Largest-remainder apportionment: distributes `total` across `weights` such
 * that the returned integers sum exactly to `total`. Zero-weight buckets never
 * receive a remainder penny unless everything is zero.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  const shares: number[] = new Array<number>(weights.length).fill(0);
  if (weights.length === 0) return shares;
  const weightSum: number = weights.reduce((sum: number, weight: number) => sum + Math.max(0, weight), 0);
  if (weightSum === 0) {
    // Nothing to weight by: hand out one unit at a time from the front.
    let remaining: number = total;
    for (let index = 0; index < shares.length && remaining !== 0; index += 1) {
      const step: number = remaining > 0 ? 1 : -1;
      shares[index] = (shares[index] ?? 0) + step;
      remaining -= step;
    }
    return shares;
  }
  const positives: number[] = weights.map((weight: number) => Math.max(0, weight));
  let assigned: number = 0;
  const remainders: { index: number; fraction: number }[] = [];
  for (let index = 0; index < shares.length; index += 1) {
    const weight: number = positives[index] ?? 0;
    const exact: number = (total * weight) / weightSum;
    const floorPart: number = Math.trunc(exact);
    shares[index] = floorPart;
    assigned += floorPart;
    remainders.push({ index, fraction: exact - floorPart });
  }
  let leftover: number = total - assigned;
  remainders.sort((a, b) => b.fraction - a.fraction);
  for (let cursor = 0; leftover !== 0; cursor += 1) {
    const bucket = remainders[cursor % remainders.length];
    if (bucket === undefined) break;
    const step: number = leftover > 0 ? 1 : -1;
    shares[bucket.index] = (shares[bucket.index] ?? 0) + step;
    leftover -= step;
  }
  return shares;
}

/** Convenience used by the cart service to render "add X more for free shipping". */
export function amountToFreeShipping(method: ShippingMethod, merchandiseTotal: Money): Money | null {
  if (method.freeOver === undefined) return null;
  if (merchandiseTotal.atLeast(method.freeOver)) return money(method.freeOver.currency, 0);
  return method.freeOver.subtract(merchandiseTotal);
}

/** A fully recomputed totals block; guarantees grand total == sum of parts. */
export interface RecomputedTotals {
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

/** Recompute a persisted order's totals from its own snapshot (audit helper). */
export function recomputeOrderTotals(input: {
  readonly currency: Currency;
  readonly itemsTotal: Money;
  readonly discountTotal: Money;
  readonly shippingTotal: Money;
  readonly taxTotal: Money;
  readonly serviceFeeTotal: Money;
  readonly amountPaid: Money;
  readonly amountRefunded: Money;
}): RecomputedTotals {
  const merchandise: Money = input.itemsTotal.subtract(input.discountTotal);
  const grandTotal: Money = merchandise.add(input.shippingTotal).add(input.taxTotal).add(input.serviceFeeTotal);
  const netPaid: Money = input.amountPaid.subtract(input.amountRefunded);
  const rawBalance: Money = grandTotal.subtract(netPaid);
  return Object.freeze({
    itemsTotal: input.itemsTotal,
    discountTotal: input.discountTotal,
    shippingTotal: input.shippingTotal,
    taxTotal: input.taxTotal,
    serviceFeeTotal: input.serviceFeeTotal,
    grandTotal,
    amountPaid: input.amountPaid,
    amountRefunded: input.amountRefunded,
    balanceDue: rawBalance.isNegative ? money(input.currency, 0) : rawBalance,
  });
}
