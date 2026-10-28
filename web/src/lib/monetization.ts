import { getSupabase } from "./supabase";

export type MonetizationEnvironment = "disabled" | "test" | "live";
export type TransactionStatus = "pending" | "succeeded" | "failed" | "refunded" | "cancelled";

export interface MonetizationConfig {
  readonly environment: MonetizationEnvironment;
  readonly provider: string | null;
  readonly paymentsEnabled: boolean;
  readonly subscriptionsEnabled: boolean;
  readonly paidPromotionsEnabled: boolean;
  readonly digitalProductsEnabled: boolean;
  readonly collaborationsEnabled: boolean;
}

export interface MonetizationPlan {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly priceCents: number | null;
  readonly currency: string | null;
  readonly billingInterval: "month" | "year" | null;
  readonly entitlements: Record<string, unknown>;
}

export interface CreatorSubscription {
  readonly id: string;
  readonly planCode: string;
  readonly status: string;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

export interface MonetizationTransaction {
  readonly id: string;
  readonly transactionKind: "promotion" | "subscription" | "digital_product" | "collaboration";
  readonly status: TransactionStatus;
  readonly amountCents: number;
  readonly currency: string;
  readonly platformFeeCents: number;
  readonly creatorNetCents: number;
  readonly createdAt: string;
}

export interface PromotionOrderSummary {
  readonly id: string;
  readonly targetType: "listing" | "profile";
  readonly status: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly createdAt: string;
}

export interface CreatorPayoutSummary {
  readonly id: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface MonetizationOverview {
  readonly config: MonetizationConfig;
  readonly plans: readonly MonetizationPlan[];
  readonly subscription: CreatorSubscription | null;
  readonly transactions: readonly MonetizationTransaction[];
  readonly promotionOrders: readonly PromotionOrderSummary[];
  readonly payouts: readonly CreatorPayoutSummary[];
}

export interface AdminRevenueSummary {
  readonly confirmedPromotionRevenueCents: number;
  readonly confirmedSubscriptionRevenueCents: number;
  readonly confirmedMarketplaceRevenueCents: number;
  readonly confirmedGrossCents: number;
  readonly confirmedPlatformFeesCents: number;
  readonly refundedCents: number;
  readonly successfulTransactionCount: number;
  readonly failedPaymentCount: number;
  readonly pendingPayoutsCents: number;
  readonly byCurrency: readonly AdminRevenueCurrencySummary[];
}

export interface AdminRevenueCurrencySummary {
  readonly currency: string;
  readonly grossCents: number;
  readonly platformFeesCents: number;
  readonly refundedCents: number;
  readonly promotionCents: number;
  readonly subscriptionCents: number;
  readonly marketplaceCents: number;
}

function requireSupabase() {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  return sb;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapConfig(row: Record<string, unknown>): MonetizationConfig {
  const environment = row.environment === "test" || row.environment === "live" ? row.environment : "disabled";
  return {
    environment,
    provider: typeof row.provider === "string" ? row.provider : null,
    paymentsEnabled: row.payments_enabled === true,
    subscriptionsEnabled: row.subscriptions_enabled === true,
    paidPromotionsEnabled: row.paid_promotions_enabled === true,
    digitalProductsEnabled: row.digital_products_enabled === true,
    collaborationsEnabled: row.collaborations_enabled === true,
  };
}

export async function getMonetizationOverview(): Promise<MonetizationOverview> {
  const sb = requireSupabase();
  const user = await sb.auth.getUser();
  const userId = user.data.user?.id;
  if (userId === undefined) throw new Error("Sign in to view monetization.");
  const [configResult, plansResult, subscriptionResult, transactionsResult, promotionResult, payoutsResult] = await Promise.all([
    sb.from("monetization_config").select("environment,provider,payments_enabled,subscriptions_enabled,paid_promotions_enabled,digital_products_enabled,collaborations_enabled").eq("id", 1).single(),
    sb.from("monetization_plans").select("code,name,description,active,price_cents,currency,billing_interval,entitlements").order("code"),
    sb.from("creator_subscriptions").select("id,plan_code,status,current_period_end,cancel_at_period_end").eq("creator_id", userId).in("status", ["incomplete", "pending", "active", "past_due"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("payment_transactions").select("id,transaction_kind,status,amount_cents,currency,platform_fee_cents,creator_net_cents,created_at").or(`buyer_id.eq.${userId},creator_id.eq.${userId}`).order("created_at", { ascending: false }).limit(25),
    sb.from("promotion_orders").select("id,target_type,status,amount_cents,currency,starts_at,ends_at,created_at").eq("creator_id", userId).order("created_at", { ascending: false }).limit(25),
    sb.from("creator_payouts").select("id,amount_cents,currency,status,created_at").eq("creator_id", userId).order("created_at", { ascending: false }).limit(25),
  ]);
  const firstError = configResult.error ?? plansResult.error ?? subscriptionResult.error ?? transactionsResult.error ?? promotionResult.error ?? payoutsResult.error;
  if (firstError) throw new Error(firstError.message);
  const config = mapConfig((configResult.data ?? {}) as Record<string, unknown>);
  const plans: MonetizationPlan[] = ((plansResult.data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const billingInterval: MonetizationPlan["billingInterval"] = row.billing_interval === "month" || row.billing_interval === "year" ? row.billing_interval : null;
    return {
      code: String(row.code), name: String(row.name), description: String(row.description), active: row.active === true,
      priceCents: row.price_cents === null || row.price_cents === undefined ? null : numberValue(row.price_cents),
      currency: typeof row.currency === "string" ? row.currency : null,
      billingInterval,
      entitlements: objectValue(row.entitlements),
    };
  });
  const subscriptionRow = subscriptionResult.data as Record<string, unknown> | null;
  return {
    config,
    plans,
    subscription: subscriptionRow === null ? null : {
      id: String(subscriptionRow.id), planCode: String(subscriptionRow.plan_code), status: String(subscriptionRow.status),
      currentPeriodEnd: typeof subscriptionRow.current_period_end === "string" ? subscriptionRow.current_period_end : null,
      cancelAtPeriodEnd: subscriptionRow.cancel_at_period_end === true,
    },
    transactions: ((transactionsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), transactionKind: String(row.transaction_kind) as MonetizationTransaction["transactionKind"], status: String(row.status) as TransactionStatus,
      amountCents: numberValue(row.amount_cents), currency: String(row.currency), platformFeeCents: numberValue(row.platform_fee_cents), creatorNetCents: numberValue(row.creator_net_cents), createdAt: String(row.created_at),
    })),
    promotionOrders: ((promotionResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), targetType: String(row.target_type) as PromotionOrderSummary["targetType"], status: String(row.status), amountCents: numberValue(row.amount_cents), currency: String(row.currency),
      startsAt: typeof row.starts_at === "string" ? row.starts_at : null, endsAt: typeof row.ends_at === "string" ? row.ends_at : null, createdAt: String(row.created_at),
    })),
    payouts: ((payoutsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), amountCents: numberValue(row.amount_cents), currency: String(row.currency), status: String(row.status), createdAt: String(row.created_at) })),
  };
}

export async function getAdminRevenueSummary(): Promise<AdminRevenueSummary> {
  const sb = requireSupabase();
  const result = await sb.rpc("admin_monetization_summary", { p_from: null, p_to: null });
  if (result.error) throw new Error(result.error.message);
  const row = objectValue(result.data);
  return {
    confirmedPromotionRevenueCents: numberValue(row.confirmedPromotionRevenueCents),
    confirmedSubscriptionRevenueCents: numberValue(row.confirmedSubscriptionRevenueCents),
    confirmedMarketplaceRevenueCents: numberValue(row.confirmedMarketplaceRevenueCents),
    confirmedGrossCents: numberValue(row.confirmedGrossCents),
    confirmedPlatformFeesCents: numberValue(row.confirmedPlatformFeesCents),
    refundedCents: numberValue(row.refundedCents),
    successfulTransactionCount: numberValue(row.successfulTransactionCount),
    failedPaymentCount: numberValue(row.failedPaymentCount),
    pendingPayoutsCents: numberValue(row.pendingPayoutsCents),
    byCurrency: (Array.isArray(row.byCurrency) ? row.byCurrency : []).flatMap((entry): AdminRevenueCurrencySummary[] => {
      if (entry === null || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.currency !== "string") return [];
      return [{
        currency: item.currency,
        grossCents: numberValue(item.grossCents),
        platformFeesCents: numberValue(item.platformFeesCents),
        refundedCents: numberValue(item.refundedCents),
        promotionCents: numberValue(item.promotionCents),
        subscriptionCents: numberValue(item.subscriptionCents),
        marketplaceCents: numberValue(item.marketplaceCents),
      }];
    }),
  };
}

export function formatMinorAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}
