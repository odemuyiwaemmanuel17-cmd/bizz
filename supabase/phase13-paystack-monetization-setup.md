# Phase 13 Paystack monetization setup

Apply after `phase12-admin-schema-alignment-migration.sql`:

```text
supabase/phase13-paystack-monetization-migration.sql
```

The migration keeps `monetization_config.environment = 'disabled'` and all
payment flags false. No charge can be initialized until an administrator
configures Paystack test mode and the server secrets below.

## Server environment variables

Set these in Vercel/Supabase server configuration only:

```text
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_PUBLIC_KEY=pk_test_...
PUBLIC_APP_URL=https://web-ten-mu-71.vercel.app
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
```

`PAYSTACK_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY` must never be placed in
`VITE_*` variables or committed to GitHub. The frontend only calls the
same-origin `/api/paystack/initialize` and `/api/paystack/verify` endpoints.

## Paystack Dashboard configuration

1. Create a Paystack test-mode integration and copy the test secret/public
   keys into the server environment.
2. Create four Paystack plans for the configured local prices:
   Pro monthly, Pro annual, Business monthly, and Business annual.
3. Copy each returned `PLN_...` code into the corresponding
   `monetization_plans.paystack_plan_code` row through the authorized admin
   configuration process/SQL editor.
4. Set the webhook URL to:

   ```text
   https://web-ten-mu-71.vercel.app/api/paystack/webhook
   ```

5. Enable test mode and the relevant feature flags only after testing the
   checkout, verification, duplicate webhook, failure, renewal, cancellation,
   and refund flows.

Paystack subscriptions use a Paystack plan code on the initial transaction;
Paystack documents that recurring billing supports cards and Nigerian direct
debit, and that subscription events must be handled through webhooks. The
local entitlement is granted only after server-side verification and the
idempotent webhook processor completes.

## Current implementation

- Free subscriptions are assigned when a profile is created.
- Pro and Business monthly/annual plans are database-configurable.
- Pricing is available at `/pricing`; signed-in billing is at
  `/dashboard/billing`.
- Checkout initialization, Paystack verification, HMAC-SHA512 webhook
  validation, duplicate event protection, subscription activation, promotion
  activation, failed payments, subscription disable/non-renew events, and
  refund state updates are server-side.
- Payment, refund, promotion, marketplace-order, and commission records are
  protected by RLS. Browser clients have no payment or entitlement write
  policy.
- Marketplace orders and commission calculations are recorded only for a
  future in-platform checkout path; WhatsApp/contact activity is never counted
  as platform revenue.

## Deliberately disabled until approval

Real charges, live mode, payouts, seller subaccounts, and production digital
delivery remain disabled until merchant verification, legal/business
configuration, Paystack test acceptance, and payout/delivery testing are
complete.

References:

- https://paystack.com/docs/payments/verify-payments/
- https://paystack.com/docs/payments/webhooks/
- https://paystack.com/docs/payments/subscriptions/
- https://paystack.com/docs/payments/split-payments/
- https://paystack.com/docs/payments/refunds/
