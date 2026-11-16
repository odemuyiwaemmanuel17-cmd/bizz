import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Server error carrying an HTTP status so handlers never have to guess.
 * Messages are safe to return to the browser: they describe the payment
 * intent, never provider credentials or customer details.
 */
export class CheckoutError extends Error {
  constructor(message, status = 400, code = "checkout_failed") {
    super(message);
    this.name = "CheckoutError";
    this.status = status;
    this.code = code;
  }
}

export function json(response, status, body) {
  response.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(body));
}

export function methodAllowed(request, response, method = "POST") {
  if (request.method === method) return true;
  response.setHeader("Allow", method);
  json(response, 405, { error: "Method not allowed." });
  return false;
}

/**
 * Maps any thrown value to a JSON error response. Unknown failures are
 * reported as 500 so a server fault never masquerades as a client error.
 */
export function sendError(response, error, fallbackMessage = "The request could not be completed.") {
  if (error instanceof CheckoutError) {
    return json(response, error.status, { error: error.message, code: error.code });
  }
  console.error("[paystack] unexpected failure", error instanceof Error ? error.message : "unknown error");
  return json(response, 500, { error: fallbackMessage, code: "server_error" });
}

/* ------------------------------------------------------------------ */
/* Infrastructure                                                      */
/* ------------------------------------------------------------------ */

export function adminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new CheckoutError("Server Supabase credentials are not configured.", 503, "server_configuration_missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function authenticatedUser(request, client) {
  const header = request.headers.authorization || request.headers.Authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new CheckoutError("Authentication is required.", 401, "authentication_required");
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new CheckoutError("Authentication is required.", 401, "authentication_required");
  const result = await client.auth.getUser(token);
  if (result.error || !result.data.user) throw new CheckoutError("Authentication is invalid or expired.", 401, "authentication_invalid");
  return result.data.user;
}

export function publicAppUrl() {
  return (process.env.PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")).replace(/\/$/, "");
}

export function paystackPublicKey() {
  return process.env.PAYSTACK_PUBLIC_KEY || null;
}

export async function paystackRequest(path, options = {}) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new CheckoutError("PAYSTACK_SECRET_KEY is not configured on the server.", 503, "server_configuration_missing");
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== true) throw new Error(body.message || `Paystack request failed (${response.status}).`);
  return body.data;
}

export async function enabledConfig(client, capability) {
  const result = await client.from("monetization_config").select("environment,provider,payments_enabled,subscriptions_enabled,paid_promotions_enabled").eq("id", 1).single();
  if (result.error) throw new CheckoutError(result.error.message, 503, "server_configuration_missing");
  const config = result.data;
  if (config.provider !== "paystack") throw new CheckoutError("Paystack is not the configured payment provider.", 409, "provider_not_configured");
  if (config.environment !== "test") throw new CheckoutError("Paystack checkout is not enabled. Configure test mode before accepting charges.", 409, "test_mode_required");
  if (config.payments_enabled !== true || config[capability] !== true) throw new CheckoutError("This payment feature is currently disabled.", 409, "feature_disabled");
  return config;
}

export function requestBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    try {
      const parsed = JSON.parse(request.body);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function reference(prefix) {
  return `hustlehub_${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function paystackSignatureMatches(body, signature, secret) {
  if (!secret || typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : "");
  const expected = crypto.createHmac("sha512", secret).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
}

/* ------------------------------------------------------------------ */
/* Plan identity                                                       */
/* ------------------------------------------------------------------ */

/** Paystack carries the charged plan in several shapes across event types. */
export function providerPlanCode(data) {
  const candidate = data?.plan?.plan_code ?? data?.plan_code ?? data?.subscription?.plan?.plan_code ?? data?.subscription?.plan_code;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

export const RECONCILIATION_REASONS = Object.freeze({
  reference_mismatch: "The verified reference does not match the local payment transaction.",
  status_not_success: "Paystack did not report a successful charge.",
  verification_data_incomplete: "Paystack did not return the amount or currency needed to verify this charge.",
  plan_code_not_configured: "This plan has no configured Paystack plan code, so the charge cannot be bound to it.",
  paystack_plan_code_missing: "Paystack did not report which plan was charged.",
  paystack_plan_mismatch: "Paystack charged a different plan than the one selected in HustleHub.",
  subscription_plan_mismatch: "The local subscription plan does not match the plan recorded on the payment transaction.",
  plan_amount_mismatch: "The amount charged by Paystack does not match the configured plan price.",
  plan_currency_mismatch: "The currency charged by Paystack does not match the configured plan currency.",
  plan_interval_invalid: "The local plan does not have a valid monthly or annual billing interval.",
  amount_mismatch: "The amount charged by Paystack does not match the local payment intent.",
  currency_mismatch: "The currency charged by Paystack does not match the local payment intent.",
  subscription_code_missing: "The charge carries no Paystack subscription code.",
  subscription_not_linked: "The Paystack subscription is not linked to exactly one HustleHub subscription.",
  subscription_ambiguous: "The Paystack subscription code matches more than one local subscription.",
  customer_code_mismatch: "The Paystack customer does not match the customer stored for the linked subscription.",
});

function reconciliation(code, verified) {
  return { ok: false, code, reconciliationRequired: true, reason: RECONCILIATION_REASONS[code] ?? "The charge requires manual reconciliation.", verified };
}

function rejection(code, verified) {
  return { ok: false, code, reconciliationRequired: false, reason: RECONCILIATION_REASONS[code] ?? "The charge could not be verified.", verified };
}

/**
 * Authoritative pre-check for a subscription charge: the plan the user
 * selected must be the plan Paystack actually charged, at the plan's exact
 * amount and currency, with a valid billing interval.
 *
 * `plan` must be the server-side `monetization_plans` row (never browser
 * input). A successful charge that diverges is reported as requiring
 * reconciliation instead of being applied or silently discarded.
 */
export function evaluateSubscriptionCharge({ local, remote, plan }) {
  const verified = {
    providerPlanCode: providerPlanCode(remote),
    amountCents: Number(remote?.amount ?? Number.NaN),
    currency: String(remote?.currency ?? "").toUpperCase(),
    billingInterval: plan?.billing_interval ?? null,
  };
  if (!local || typeof local !== "object") return rejection("reference_mismatch", verified);
  if (String(remote?.reference ?? "") !== String(local.provider_reference ?? "")) return rejection("reference_mismatch", verified);
  if (remote?.status !== "success") return rejection("status_not_success", verified);

  const expectedPlanCode = typeof plan?.paystack_plan_code === "string" && plan.paystack_plan_code.length > 0
    ? plan.paystack_plan_code
    : (typeof local?.metadata?.paystack_plan_code === "string" ? local.metadata.paystack_plan_code : null);
  const expectedAmount = Number(plan?.price_cents ?? local?.amount_cents);
  const expectedCurrency = String(plan?.currency ?? local?.currency ?? "").toUpperCase();

  if (!Number.isFinite(verified.amountCents) || !Number.isFinite(expectedAmount) || expectedCurrency.length === 0) return reconciliation("verification_data_incomplete", verified);
  if (!expectedPlanCode) return reconciliation("plan_code_not_configured", verified);
  if (!verified.providerPlanCode) return reconciliation("paystack_plan_code_missing", verified);
  if (verified.providerPlanCode !== expectedPlanCode) return reconciliation("paystack_plan_mismatch", verified);
  if (typeof local?.metadata?.plan_code === "string" && typeof plan?.code === "string" && local.metadata.plan_code !== plan.code) return reconciliation("subscription_plan_mismatch", verified);
  if (verified.amountCents !== expectedAmount) return reconciliation("plan_amount_mismatch", verified);
  if (verified.currency !== expectedCurrency) return reconciliation("plan_currency_mismatch", verified);
  if (plan && plan.billing_interval !== "month" && plan.billing_interval !== "year") return reconciliation("plan_interval_invalid", verified);

  return {
    ok: true,
    code: "verified",
    reconciliationRequired: false,
    reason: null,
    verified: { ...verified, billingInterval: plan?.billing_interval ?? local?.metadata?.billing_interval ?? null },
  };
}

/**
 * Legacy amount/currency/reference assertion kept for promotion charges and
 * for callers that predate plan binding.
 */
export function assertVerifiedTransaction(local, remote) {
  if (remote?.reference !== local.provider_reference || remote?.status !== "success" || Number(remote?.amount) !== Number(local.amount_cents) || String(remote?.currency).toUpperCase() !== String(local.currency).toUpperCase()) {
    throw new Error("Payment verification did not match the expected transaction.");
  }
}

/** Ownership is decided by the authenticated HustleHub user, never by email. */
export function assertTransactionOwnership(local, userId) {
  if (!local || typeof userId !== "string" || local.buyer_id !== userId) {
    throw new CheckoutError("Payment transaction not found for this account.", 404, "transaction_not_found");
  }
  return local;
}

/* ------------------------------------------------------------------ */
/* Cross-account association                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolves the local subscription for a charge with no local transaction.
 * Only an exact, unique Paystack subscription code may attribute the charge;
 * a customer code may only confirm the link, never create it. Customer email
 * is never consulted.
 */
export function matchRenewalTarget(subscriptions, { subscriptionCode, customerCode }) {
  if (typeof subscriptionCode !== "string" || subscriptionCode.length === 0) return { target: null, reason: "subscription_code_missing" };
  const matches = (subscriptions ?? []).filter((row) => row?.provider_subscription_id === subscriptionCode);
  if (matches.length === 0) return { target: null, reason: "subscription_not_linked" };
  if (matches.length > 1) return { target: null, reason: "subscription_ambiguous" };
  const target = matches[0];
  if (customerCode && target.provider_customer_code && customerCode !== target.provider_customer_code) return { target: null, reason: "customer_code_mismatch" };
  return { target, reason: null };
}

/* ------------------------------------------------------------------ */
/* Checkout intent                                                     */
/* ------------------------------------------------------------------ */

/**
 * Decides how a new subscription checkout interacts with an existing
 * unconfirmed one. Historical rows are never deleted: a superseded attempt is
 * cancelled with an audit trail by the server-side RPC.
 */
export function selectCheckoutAction({ pending, planCode }) {
  if (!pending) return { action: "create", supersededId: null, reason: null };
  const pendingPlan = pending.plan_code ?? pending.planCode ?? null;
  const pendingStatus = pending.status ?? null;
  if (pendingPlan === planCode && pendingStatus === "pending") {
    return {
      action: "reject",
      supersededId: null,
      reason: "A checkout for this plan is already pending. Complete it, or choose a different plan to replace it.",
    };
  }
  return {
    action: "supersede",
    supersededId: pending.id ?? null,
    reason: `Superseded by a newer ${planCode} checkout.`,
  };
}

/* ------------------------------------------------------------------ */
/* Entitlement rules (mirror of has_monetization_entitlement)          */
/* ------------------------------------------------------------------ */

export function isEntitled(subscription, now = Date.now()) {
  if (!subscription || subscription.status !== "active") return false;
  const end = subscription.current_period_end ?? subscription.currentPeriodEnd ?? null;
  if (end === null || end === undefined || end === "") return true;
  const parsed = Date.parse(end);
  return Number.isFinite(parsed) ? parsed > now : true;
}

/* ------------------------------------------------------------------ */
/* Webhook ingest                                                      */
/* ------------------------------------------------------------------ */

function webhookEventId(event, body, cryptoModule) {
  const data = event?.data || {};
  const digest = cryptoModule.createHash("sha256").update(body).digest("hex");
  return String(event?.id || `${event?.event || "paystack"}:${data.id || data.reference || digest}`);
}

/**
 * Verifies and normalises a Paystack webhook before any database work.
 * Signature failures never reach the RPC, and nothing sensitive is logged.
 */
export async function ingestWebhook({ rawBody, signature, secret, rpc }) {
  if (!secret) return { status: "unconfigured" };
  if (!paystackSignatureMatches(rawBody, signature, secret)) return { status: "unauthorized" };
  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
  } catch {
    return { status: "invalid_json" };
  }
  const data = event?.data || {};
  const args = {
    p_event_id: webhookEventId(event, rawBody, crypto),
    p_event_type: String(event.event || "unknown"),
    p_reference: data.reference || data.transaction?.reference || null,
    p_status: String(data.status || data.transaction?.status || ""),
    p_amount_cents: Number(data.amount || data.transaction?.amount || 0),
    p_currency: String(data.currency || data.transaction?.currency || "").toUpperCase(),
    p_payload: event,
    p_provider_plan_code: providerPlanCode(data),
  };
  const diagnostic = {
    event: args.p_event_type,
    eventId: args.p_event_id,
    reference: args.p_reference,
    providerPlanCode: args.p_provider_plan_code,
    hasCustomerCode: typeof data?.customer?.customer_code === "string",
  };
  let result = null;
  try {
    result = await rpc(args);
  } catch (error) {
    return { status: "failed", diagnostic, message: error instanceof Error ? error.message : "Webhook processing failed." };
  }
  if (result?.reconciliation_required === true) {
    return { status: "needs_reconciliation", diagnostic, result };
  }
  return { status: "processed", diagnostic, result };
}

export function checkoutKind(value) {
  if (value === "subscription" || value === "promotion") return value;
  throw new CheckoutError("A valid checkout type is required.", 400, "invalid_checkout_kind");
}
