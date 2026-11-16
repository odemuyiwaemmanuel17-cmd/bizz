import { createHmac } from "node:crypto";
import { test, expect } from "vitest";
import {
  assertTransactionOwnership,
  evaluateSubscriptionCharge,
  ingestWebhook,
  isEntitled,
  matchRenewalTarget,
  selectCheckoutAction,
} from "../api/_paystack.mjs";

const SECRET = "sk_test_unit_test_secret";

const PRO = { code: "pro_monthly", price_cents: 350000, currency: "NGN", billing_interval: "month", paystack_plan_code: "PLN_6p9eo2b5a0cnx05" };
const BUSINESS = { code: "business_monthly", price_cents: 1000000, currency: "NGN", billing_interval: "month", paystack_plan_code: "PLN_6dlmnyi74htaaeo" };

function local(overrides = {}) {
  return {
    id: "tx-1",
    buyer_id: "user-a",
    provider_reference: "hustlehub_subscription_reference",
    amount_cents: PRO.price_cents,
    currency: "NGN",
    status: "pending",
    metadata: { hustlehub_kind: "subscription", plan_code: PRO.code, paystack_plan_code: PRO.paystack_plan_code },
    ...overrides,
  };
}

function chargeFor(target, plan, overrides = {}) {
  return {
    reference: target.provider_reference,
    status: "success",
    amount: plan.price_cents,
    currency: "NGN",
    plan: { plan_code: plan.paystack_plan_code },
    ...overrides,
  };
}

/* 1 ------------------------------------------------------------------ */
test("a Pro checkout cannot receive a Business charge or entitlement", () => {
  const result = evaluateSubscriptionCharge({ local: local(), remote: chargeFor(local(), BUSINESS), plan: PRO });
  expect(result.ok).toBe(false);
  expect(result.reconciliationRequired).toBe(true);
  expect(result.code).toBe("paystack_plan_mismatch");
  expect(result.verified?.providerPlanCode).toBe(BUSINESS.paystack_plan_code);
});

/* 2 ------------------------------------------------------------------ */
test("a Business checkout cannot receive a Pro charge or entitlement", () => {
  const businessLocal = local({
    amount_cents: BUSINESS.price_cents,
    metadata: { hustlehub_kind: "subscription", plan_code: BUSINESS.code, paystack_plan_code: BUSINESS.paystack_plan_code },
  });
  const result = evaluateSubscriptionCharge({ local: businessLocal, remote: chargeFor(businessLocal, PRO), plan: BUSINESS });
  expect(result.ok).toBe(false);
  expect(result.reconciliationRequired).toBe(true);
  expect(result.code).toBe("paystack_plan_mismatch");
});

/* 3 ------------------------------------------------------------------ */
test("account A cannot read or verify account B's transaction", () => {
  expect(() => assertTransactionOwnership(local({ buyer_id: "user-b" }), "user-a")).toThrow();
  expect(() => assertTransactionOwnership(null, "user-a")).toThrow();
  expect(assertTransactionOwnership(local({ buyer_id: "user-a" }), "user-a").buyer_id).toBe("user-a");
});

/* 4 ------------------------------------------------------------------ */
test("account B cannot be linked to account A's Paystack subscription", () => {
  const subscriptions = [
    { id: "sub-a", creator_id: "user-a", provider_subscription_id: "SUB_A", provider_customer_code: "CUS_SHARED" },
    { id: "sub-b", creator_id: "user-b", provider_subscription_id: "SUB_B", provider_customer_code: "CUS_SHARED" },
  ];
  expect(matchRenewalTarget(subscriptions, { subscriptionCode: "SUB_A", customerCode: "CUS_SHARED" }).target?.creator_id).toBe("user-a");
  expect(matchRenewalTarget(subscriptions, { subscriptionCode: "SUB_B", customerCode: "CUS_SHARED" }).target?.creator_id).toBe("user-b");
  // A code that does not exist locally is never resolved through the customer.
  expect(matchRenewalTarget(subscriptions, { subscriptionCode: "SUB_MISSING", customerCode: "CUS_SHARED" }).target).toBeNull();
});

/* 5 ------------------------------------------------------------------ */
test("pending, failed, cancelled, expired and unreconciled subscriptions grant nothing", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  expect(isEntitled(null)).toBe(false);
  expect(isEntitled({ status: "pending", current_period_end: future })).toBe(false);
  expect(isEntitled({ status: "incomplete" })).toBe(false);
  expect(isEntitled({ status: "failed" })).toBe(false);
  expect(isEntitled({ status: "cancelled", current_period_end: future })).toBe(false);
  expect(isEntitled({ status: "expired" })).toBe(false);
  expect(isEntitled({ status: "needs_reconciliation" })).toBe(false);
  expect(isEntitled({ status: "active", current_period_end: past })).toBe(false);
  expect(isEntitled({ status: "active", current_period_end: future })).toBe(true);
  expect(isEntitled({ status: "active", current_period_end: null })).toBe(true);
});

/* 6 ------------------------------------------------------------------ */
test("invalid webhook signatures never reach the database", async () => {
  const event = { id: "evt_1", event: "charge.success", data: { reference: "hustlehub_subscription_reference", status: "success", amount: 350000, currency: "NGN" } };
  const rawBody = Buffer.from(JSON.stringify(event));
  let calls = 0;
  const rpc = async () => {
    calls += 1;
    return { processed: true };
  };

  const missing = await ingestWebhook({ rawBody, signature: undefined, secret: SECRET, rpc });
  expect(missing.status).toBe("unauthorized");

  const wrongSecret = createHmac("sha512", "sk_test_other_secret").update(rawBody).digest("hex");
  expect((await ingestWebhook({ rawBody, signature: wrongSecret, secret: SECRET, rpc })).status).toBe("unauthorized");

  const valid = createHmac("sha512", SECRET).update(rawBody).digest("hex");
  const tampered = Buffer.from(JSON.stringify({ ...event, data: { ...event.data, amount: 1000000 } }));
  expect((await ingestWebhook({ rawBody: tampered, signature: valid, secret: SECRET, rpc })).status).toBe("unauthorized");

  const unconfigured = await ingestWebhook({ rawBody, signature: valid, secret: undefined, rpc });
  expect(unconfigured.status).toBe("unconfigured");
  expect(calls).toBe(0);

  const accepted = await ingestWebhook({ rawBody, signature: valid, secret: SECRET, rpc });
  expect(accepted.status).toBe("processed");
  expect(calls).toBe(1);
});

/* 7 ------------------------------------------------------------------ */
test("duplicate webhook deliveries cannot duplicate entitlements", async () => {
  const event = { id: "evt_duplicate", event: "charge.success", data: { reference: "hustlehub_subscription_reference", status: "success", amount: 350000, currency: "NGN" } };
  const rawBody = Buffer.from(JSON.stringify(event));
  const signature = createHmac("sha512", SECRET).update(rawBody).digest("hex");
  const eventIds = [];
  const results = [{ processed: true }, { duplicate: true }];
  const rpc = async (args) => {
    eventIds.push(args.p_event_id);
    return results[Math.min(eventIds.length - 1, results.length - 1)];
  };

  const first = await ingestWebhook({ rawBody, signature, secret: SECRET, rpc });
  const second = await ingestWebhook({ rawBody, signature, secret: SECRET, rpc });

  expect(first.status).toBe("processed");
  expect(first.result).toEqual({ processed: true });
  expect(second.status).toBe("processed");
  expect(second.result).toEqual({ duplicate: true });
  // The same provider event id is replayed, which is what makes entitlement
  // duplication impossible at the database level.
  expect(eventIds).toEqual(["evt_duplicate", "evt_duplicate"]);
});

/* 8 ------------------------------------------------------------------ */
test("an unknown renewal is never assigned using customer email or customer code alone", () => {
  const subscriptions = [
    { id: "sub-a", creator_id: "user-a", provider_subscription_id: "SUB_A", provider_customer_code: "CUS_SHARED" },
  ];
  const byEmailOnly = matchRenewalTarget(subscriptions, { subscriptionCode: null, customerCode: "CUS_SHARED", customerEmail: "owner@example.com" });
  expect(byEmailOnly.target).toBeNull();
  expect(byEmailOnly.reason).toBe("subscription_code_missing");

  const unknownCode = matchRenewalTarget(subscriptions, { subscriptionCode: "SUB_UNKNOWN", customerCode: "CUS_SHARED" });
  expect(unknownCode.target).toBeNull();
  expect(unknownCode.reason).toBe("subscription_not_linked");

  const ambiguous = matchRenewalTarget([...subscriptions, { ...subscriptions[0], id: "sub-a-copy" }], { subscriptionCode: "SUB_A", customerCode: "CUS_SHARED" });
  expect(ambiguous.target).toBeNull();
  expect(ambiguous.reason).toBe("subscription_ambiguous");
});

/* 9 ------------------------------------------------------------------ */
test("only one outstanding checkout exists per user and superseding keeps history", () => {
  expect(selectCheckoutAction({ pending: null, planCode: "pro_monthly" })).toEqual({ action: "create", supersededId: null, reason: null });

  const samePlan = selectCheckoutAction({ pending: { id: "sub-1", plan_code: "pro_monthly", status: "pending" }, planCode: "pro_monthly" });
  expect(samePlan.action).toBe("reject");
  expect(samePlan.supersededId).toBeNull();

  const otherPlan = selectCheckoutAction({ pending: { id: "sub-1", plan_code: "pro_monthly", status: "pending" }, planCode: "business_monthly" });
  expect(otherPlan.action).toBe("supersede");
  expect(otherPlan.supersededId).toBe("sub-1");

  const retryAfterFailure = selectCheckoutAction({ pending: { id: "sub-2", plan_code: "pro_monthly", status: "incomplete" }, planCode: "pro_monthly" });
  expect(retryAfterFailure.action).toBe("supersede");
  expect(retryAfterFailure.supersededId).toBe("sub-2");
});

/* 10 ----------------------------------------------------------------- */
test("a successful charge with a plan mismatch is flagged for reconciliation, not applied", () => {
  const mismatched = evaluateSubscriptionCharge({
    local: local(),
    remote: chargeFor(local(), BUSINESS, { status: "success", amount: BUSINESS.price_cents }),
    plan: PRO,
  });
  expect(mismatched.ok).toBe(false);
  expect(mismatched.reconciliationRequired).toBe(true);
  expect(mismatched.code).toBe("paystack_plan_mismatch");

  const amountOnlyMismatch = evaluateSubscriptionCharge({
    local: local(),
    remote: chargeFor(local(), PRO, { amount: PRO.price_cents + 100 }),
    plan: PRO,
  });
  expect(amountOnlyMismatch.ok).toBe(false);
  expect(amountOnlyMismatch.reconciliationRequired).toBe(true);
  expect(amountOnlyMismatch.code).toBe("plan_amount_mismatch");

  // Control: the same charge with the selected plan verifies cleanly.
  const verified = evaluateSubscriptionCharge({ local: local(), remote: chargeFor(local(), PRO), plan: PRO });
  expect(verified.ok).toBe(true);
  expect(verified.reconciliationRequired).toBe(false);
  expect(verified.verified.providerPlanCode).toBe(PRO.paystack_plan_code);
  expect(verified.verified.billingInterval).toBe("month");
});
