import { getSupabase } from "./supabase";

export type MonetizationEnvironment = "disabled" | "test";
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
  readonly audience: "all" | "creator" | "business";
  readonly paystackPlanCode: string | null;
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

export interface PromotionPackage {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly placement: string;
  readonly durationDays: number;
  readonly priceCents: number;
  readonly currency: string;
  readonly terms: string;
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

export interface AdminPaymentTransaction {
  readonly id: string;
  readonly buyerId: string | null;
  readonly creatorId: string | null;
  readonly transactionKind: string;
  readonly status: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly platformFeeCents: number;
  readonly creatorNetCents: number;
  readonly provider: string | null;
  readonly providerReference: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
}

interface PaymentHistoryResponse {
  readonly subscription: Record<string, unknown> | null;
  readonly transactions: Array<Record<string, unknown>>;
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
  const environment = row.environment === "test" ? row.environment : "disabled";
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
  const [configResult, plansResult, history, promotionResult, payoutsResult] = await Promise.all([
    sb.from("monetization_config").select("environment,provider,payments_enabled,subscriptions_enabled,paid_promotions_enabled,digital_products_enabled,collaborations_enabled").eq("id", 1).single(),
    sb.from("monetization_plans").select("code,name,description,active,price_cents,currency,billing_interval,entitlements,audience,paystack_plan_code").order("display_order").order("code"),
    getPaymentHistory(),
    sb.from("promotion_orders").select("id,target_type,status,amount_cents,currency,starts_at,ends_at,created_at").eq("creator_id", userId).order("created_at", { ascending: false }).limit(25),
    sb.from("creator_payouts").select("id,amount_cents,currency,status,created_at").eq("creator_id", userId).order("created_at", { ascending: false }).limit(25),
  ]);
  const firstError = configResult.error ?? plansResult.error ?? promotionResult.error ?? payoutsResult.error;
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
      audience: row.audience === "business" || row.audience === "all" ? row.audience : "creator",
      paystackPlanCode: typeof row.paystack_plan_code === "string" ? row.paystack_plan_code : null,
    };
  });
  const subscriptionRow = history.subscription;
  return {
    config,
    plans,
    subscription: subscriptionRow === null ? null : {
      id: String(subscriptionRow.id), planCode: String(subscriptionRow.plan_code), status: String(subscriptionRow.status),
      currentPeriodEnd: typeof subscriptionRow.current_period_end === "string" ? subscriptionRow.current_period_end : null,
      cancelAtPeriodEnd: subscriptionRow.cancel_at_period_end === true,
    },
    transactions: history.transactions.map((row) => ({
      id: String(row.id), transactionKind: String(row.transactionKind) as MonetizationTransaction["transactionKind"], status: String(row.status) as TransactionStatus,
      amountCents: numberValue(row.amountCents), currency: String(row.currency), platformFeeCents: numberValue(row.platformFeeCents), creatorNetCents: numberValue(row.creatorNetCents), createdAt: String(row.createdAt),
    })),
    promotionOrders: ((promotionResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), targetType: String(row.target_type) as PromotionOrderSummary["targetType"], status: String(row.status), amountCents: numberValue(row.amount_cents), currency: String(row.currency),
      startsAt: typeof row.starts_at === "string" ? row.starts_at : null, endsAt: typeof row.ends_at === "string" ? row.ends_at : null, createdAt: String(row.created_at),
    })),
    payouts: ((payoutsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), amountCents: numberValue(row.amount_cents), currency: String(row.currency), status: String(row.status), createdAt: String(row.created_at) })),
  };
}

export async function getPaymentHistory(): Promise<PaymentHistoryResponse> {
  const response = await fetch("/api/paystack/transactions", { method: "GET", headers: await authenticatedApiHeaders() });
  const body = await response.json().catch(() => ({})) as Partial<PaymentHistoryResponse> & { error?: string };
  if (!response.ok || !Array.isArray(body.transactions)) throw new Error(body.error ?? "Payment history could not be loaded.");
  return { subscription: body.subscription !== null && typeof body.subscription === "object" ? body.subscription as Record<string, unknown> : null, transactions: body.transactions.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object") };
}

export async function getPublicPlans(): Promise<readonly MonetizationPlan[]> {
  const result = await requireSupabase().from("monetization_plans").select("code,name,description,active,price_cents,currency,billing_interval,entitlements,audience,paystack_plan_code").eq("active", true).order("display_order").order("code");
  if (result.error) throw new Error(result.error.message);
  return ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    code: String(row.code), name: String(row.name), description: String(row.description), active: row.active === true,
    priceCents: row.price_cents === null || row.price_cents === undefined ? null : numberValue(row.price_cents),
    currency: typeof row.currency === "string" ? row.currency : null,
    billingInterval: row.billing_interval === "month" || row.billing_interval === "year" ? row.billing_interval : null,
    entitlements: objectValue(row.entitlements), audience: row.audience === "business" || row.audience === "all" ? row.audience : "creator",
    paystackPlanCode: typeof row.paystack_plan_code === "string" ? row.paystack_plan_code : null,
  }));
}

export async function getPromotionPackages(): Promise<readonly PromotionPackage[]> {
  const result = await requireSupabase().from("promotion_packages").select("id,code,name,placement,duration_days,price_cents,currency,terms").eq("active", true).order("price_cents");
  if (result.error) throw new Error(result.error.message);
  return ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name), placement: String(row.placement), durationDays: numberValue(row.duration_days), priceCents: numberValue(row.price_cents), currency: String(row.currency), terms: String(row.terms) }));
}

async function authenticatedApiHeaders(): Promise<HeadersInit> {
  const session = await requireSupabase().auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error("Sign in to continue.");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function startPaystackCheckout(input: { readonly kind: "subscription" | "promotion"; readonly planCode?: string; readonly packageId?: string; readonly targetId?: string }): Promise<{ readonly authorizationUrl: string; readonly reference: string }> {
  const response = await fetch("/api/paystack/initialize", { method: "POST", headers: await authenticatedApiHeaders(), body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({})) as { authorizationUrl?: string; reference?: string; error?: string };
  if (!response.ok || typeof body.authorizationUrl !== "string" || typeof body.reference !== "string") throw new Error(body.error ?? "Paystack checkout could not be initialized.");
  return { authorizationUrl: body.authorizationUrl, reference: body.reference };
}

export async function verifyPaystackPayment(reference: string): Promise<void> {
  const response = await fetch("/api/paystack/verify", { method: "POST", headers: await authenticatedApiHeaders(), body: JSON.stringify({ reference }) });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Payment could not be verified.");
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

export async function listAdminPaymentTransactions(search: string, status: string, kind: string, page = 0): Promise<{ readonly rows: readonly AdminPaymentTransaction[]; readonly total: number }> {
  const result = await requireSupabase().rpc("admin_list_payment_transactions", { p_search: search.trim() || null, p_status: status || null, p_kind: kind || null, p_from: null, p_to: null, p_page: page, p_page_size: 25 });
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as Array<Record<string, unknown>>;
  return { total: numberValue(rows[0]?.total_count), rows: rows.map((row) => ({ id: String(row.id), buyerId: typeof row.buyer_id === "string" ? row.buyer_id : null, creatorId: typeof row.creator_id === "string" ? row.creator_id : null, transactionKind: String(row.transaction_kind), status: String(row.status), amountCents: numberValue(row.amount_cents), currency: String(row.currency), platformFeeCents: numberValue(row.platform_fee_cents), creatorNetCents: numberValue(row.creator_net_cents), provider: typeof row.provider === "string" ? row.provider : null, providerReference: typeof row.provider_reference === "string" ? row.provider_reference : null, failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null, createdAt: String(row.created_at) })) };
}

export async function updateAdminMonetizationConfig(input: { readonly environment: MonetizationEnvironment; readonly paymentsEnabled: boolean; readonly subscriptionsEnabled: boolean; readonly paidPromotionsEnabled: boolean }): Promise<void> {
  const result = await requireSupabase().rpc("admin_update_monetization_config", { p_environment: input.environment, p_provider: "paystack", p_payments_enabled: input.paymentsEnabled, p_subscriptions_enabled: input.subscriptionsEnabled, p_paid_promotions_enabled: input.paidPromotionsEnabled });
  if (result.error) throw new Error(result.error.message);
}

export async function getAdminMonetizationConfig(): Promise<MonetizationConfig> {
  const result = await requireSupabase().from("monetization_config").select("environment,provider,payments_enabled,subscriptions_enabled,paid_promotions_enabled,digital_products_enabled,collaborations_enabled").eq("id", 1).single();
  if (result.error) throw new Error(result.error.message);
  return mapConfig(result.data as Record<string, unknown>);
}

export async function getAdminPlans(): Promise<readonly MonetizationPlan[]> {
  const result = await requireSupabase().from("monetization_plans").select("code,name,description,active,price_cents,currency,billing_interval,entitlements,audience,paystack_plan_code").order("display_order").order("code");
  if (result.error) throw new Error(result.error.message);
  return ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => ({ code: String(row.code), name: String(row.name), description: String(row.description), active: row.active === true, priceCents: row.price_cents === null || row.price_cents === undefined ? null : numberValue(row.price_cents), currency: typeof row.currency === "string" ? row.currency : null, billingInterval: row.billing_interval === "month" || row.billing_interval === "year" ? row.billing_interval : null, entitlements: objectValue(row.entitlements), audience: row.audience === "business" || row.audience === "all" ? row.audience : "creator", paystackPlanCode: typeof row.paystack_plan_code === "string" ? row.paystack_plan_code : null }));
}

export async function updateAdminPlan(plan: MonetizationPlan, priceCents: number | null, active: boolean, entitlements: Record<string, unknown>): Promise<void> {
  const result = await requireSupabase().rpc("admin_update_monetization_plan", { p_code: plan.code, p_name: plan.name, p_description: plan.description, p_active: active, p_price_cents: priceCents, p_currency: plan.currency ?? "NGN", p_billing_interval: plan.billingInterval, p_entitlements: entitlements, p_paystack_plan_code: plan.paystackPlanCode });
  if (result.error) throw new Error(result.error.message);
}

export function formatMinorAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}
