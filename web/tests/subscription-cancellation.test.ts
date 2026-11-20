import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { assertPaystackManageLink, isCancellableSubscription } from "../api/_paystack.mjs";

const NOW = Date.parse("2026-05-01T00:00:00.000Z");

function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    plan_code: "pro_monthly",
    status: "active",
    provider: "paystack",
    provider_subscription_id: "SUB_test_code",
    current_period_end: "2026-06-01T00:00:00.000Z",
    cancel_at_period_end: false,
    ...overrides,
  };
}

describe("isCancellableSubscription", () => {
  test("accepts an active Paystack subscription inside its paid period", () => {
    expect(isCancellableSubscription(subscription(), NOW)).toBe(true);
    expect(isCancellableSubscription(subscription({ cancel_at_period_end: true }), NOW)).toBe(true);
  });

  test("accepts a past-due subscription so the user can stop further charges", () => {
    expect(isCancellableSubscription(subscription({ status: "past_due" }), NOW)).toBe(true);
  });

  test("rejects every state that is not a live paid subscription", () => {
    for (const status of ["pending", "incomplete", "needs_reconciliation", "cancelled", "expired"]) {
      expect(isCancellableSubscription(subscription({ status }), NOW)).toBe(false);
    }
  });

  test("rejects subscriptions without a real Paystack subscription code", () => {
    expect(isCancellableSubscription(subscription({ provider: null }), NOW)).toBe(false);
    expect(isCancellableSubscription(subscription({ provider: "stripe" }), NOW)).toBe(false);
    expect(isCancellableSubscription(subscription({ provider_subscription_id: null }), NOW)).toBe(false);
    expect(isCancellableSubscription(subscription({ provider_subscription_id: "   " }), NOW)).toBe(false);
  });

  test("rejects a subscription whose paid period has already ended", () => {
    expect(isCancellableSubscription(subscription({ current_period_end: "2026-04-01T00:00:00.000Z" }), NOW)).toBe(false);
    expect(isCancellableSubscription(subscription({ current_period_end: "not-a-date" }), NOW)).toBe(false);
  });

  test("accepts an open-ended paid subscription", () => {
    expect(isCancellableSubscription(subscription({ current_period_end: null }), NOW)).toBe(true);
    expect(isCancellableSubscription(subscription({ current_period_end: undefined }), NOW)).toBe(true);
  });

  test("rejects missing rows", () => {
    expect(isCancellableSubscription(null, NOW)).toBe(false);
    expect(isCancellableSubscription(undefined, NOW)).toBe(false);
  });
});

describe("assertPaystackManageLink", () => {
  test("accepts https links on Paystack's own domains", () => {
    expect(assertPaystackManageLink("https://paystack.com/manage/abc")).toContain("paystack.com/manage/abc");
    expect(assertPaystackManageLink("https://dashboard.paystack.com/#/subscription/abc")).toContain("dashboard.paystack.com");
    expect(assertPaystackManageLink("  https://checkout.paystack.com/xyz  ")).toContain("checkout.paystack.com");
  });

  test("rejects non-https, lookalike hosts and non-URL values", () => {
    for (const bad of [
      "http://paystack.com/manage/abc",
      "https://paystack.com.evil.example/manage/abc",
      "https://evil.example/?next=https://paystack.com",
      "javascript:alert(1)",
      "//paystack.com/manage/abc",
      "paystack.com/manage/abc",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(() => assertPaystackManageLink(bad)).toThrow();
    }
  });

  test("rejects a missing provider link", () => {
    expect(() => assertPaystackManageLink(undefined)).toThrow(/management link/i);
  });
});

const lifecycleSql = readFileSync(
  new URL("../../supabase/phase18-subscription-cancellation-lifecycle-migration.sql", import.meta.url),
  "utf8",
);

describe("phase18 cancellation lifecycle migration", () => {
  test("subscription.not_renew keeps the paid subscription active", () => {
    // Regression guard: the previous body mapped not_renew to 'cancelled',
    // which revoked access the user had already paid for.
    expect(lifecycleSql).not.toContain("'expired' else 'cancelled'");
    expect(lifecycleSql).not.toContain("status = next_status");
    expect(lifecycleSql).toContain("set cancel_at_period_end = true, updated_at = now()");
    expect(lifecycleSql).toContain("'renewal_disabled', true");
  });

  test("subscription.disable still ends entitlement but never resurrects state", () => {
    expect(lifecycleSql).toContain("set status = 'expired', cancel_at_period_end = true");
    expect(lifecycleSql).toContain("and status <> 'expired'");
  });

  test("cancellation events for inactive or code-less subscriptions are ignored", () => {
    expect(lifecycleSql).toContain("'subscription_code_missing'");
    expect(lifecycleSql).toContain("'subscription_not_active'");
    expect(lifecycleSql).toContain("and status in ('active', 'past_due')");
  });

  test("the migration is transactional and preserves the 8-argument signature", () => {
    expect(lifecycleSql).toContain("begin;");
    expect(lifecycleSql).toContain("commit;");
    expect(lifecycleSql).toContain("p_provider_plan_code text default null");
    expect(lifecycleSql).toContain("grant execute on function public.process_paystack_event(text, text, text, text, bigint, text, jsonb, text) to service_role;");
  });
});
