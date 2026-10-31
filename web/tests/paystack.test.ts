import { createHmac } from "node:crypto";
import { test, expect } from "vitest";
import { assertVerifiedTransaction, checkoutKind, paystackSignatureMatches } from "../api/_paystack.mjs";

const secret = "sk_test_unit_test_secret";
const payload = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "hustlehub_subscription_reference" } }));

test("Paystack signature validation accepts the exact HMAC and rejects invalid signatures", () => {
  const valid = createHmac("sha512", secret).update(payload).digest("hex");
  expect(paystackSignatureMatches(payload, valid, secret)).toBe(true);
  expect(paystackSignatureMatches(payload, valid.toUpperCase(), secret)).toBe(true);
  expect(paystackSignatureMatches(payload, `${valid.slice(0, -1)}0`, secret)).toBe(false);
  expect(paystackSignatureMatches(payload, "", secret)).toBe(false);
  expect(paystackSignatureMatches(payload, valid, "wrong-secret")).toBe(false);
});

test("server transaction verification rejects reference, status, amount, and currency mismatches", () => {
  const local = { provider_reference: "hustlehub_subscription_reference", amount_cents: 350000, currency: "NGN" };
  expect(() => assertVerifiedTransaction(local, { reference: "hustlehub_other", status: "success", amount: 350000, currency: "NGN" })).toThrow();
  expect(() => assertVerifiedTransaction(local, { reference: local.provider_reference, status: "failed", amount: 350000, currency: "NGN" })).toThrow();
  expect(() => assertVerifiedTransaction(local, { reference: local.provider_reference, status: "success", amount: 350001, currency: "NGN" })).toThrow();
  expect(() => assertVerifiedTransaction(local, { reference: local.provider_reference, status: "success", amount: 350000, currency: "USD" })).toThrow();
  expect(() => assertVerifiedTransaction(local, { reference: local.provider_reference, status: "success", amount: 350000, currency: "NGN" })).not.toThrow();
});

test("checkout accepts only supported product purposes", () => {
  expect(checkoutKind("subscription")).toBe("subscription");
  expect(checkoutKind("promotion")).toBe("promotion");
  expect(() => checkoutKind("marketplace")).toThrow();
  expect(() => checkoutKind(undefined)).toThrow();
});
