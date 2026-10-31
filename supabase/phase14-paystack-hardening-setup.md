# Phase 14 Paystack test-mode hardening

Apply after:

```text
supabase/phase13-paystack-monetization-migration.sql
supabase/phase14-paystack-hardening-migration.sql
```

This migration keeps the provider restricted to Paystack test mode. The admin
configuration RPC rejects `live`, and the UI exposes only Disabled and Test.

It adds:

- effective-period entitlement checks and trusted expiry processing;
- renewal-charge transaction reconstruction from an existing subscription and
  trusted local plan price;
- `subscription.create`, failed-payment, disable, and non-renew event updates;
- refund records and subscription revocation after processed refunds;
- administrator access to inactive plan records for configuration.

The trusted transaction-history endpoint is:

```text
GET /api/paystack/transactions
```

It requires the signed-in user's Supabase access token and never accepts a user
ID from the browser.
