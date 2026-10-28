# Phase 10 monetization setup

## Current state

Phase 10 adds database-backed monetization records and disabled creator/admin
surfaces. HustleHub does not currently have a payment provider, server-side
checkout, signed webhook endpoint, recurring billing worker, digital-delivery
service, or payout integration. The migration therefore leaves every charge
and activation flag disabled.

The application continues to support free profiles, Bizzes, videos, social
features, and recorded analytics.

## Migration order

Apply these in Supabase SQL Editor:

1. `schema.sql` / `schema-patch.sql` as required by the existing deployment.
2. `phase7-community-trust-migration.sql`.
3. `creator-verification-admin-migration.sql`.
4. `phase10-monetization-migration.sql`.

The Phase 10 migration expects `public.is_verification_admin()` from the
creator verification admin migration.

## Records created

- `monetization_config` — owner-controlled disabled/test/live feature flags.
- `monetization_plans` — free and inactive Pro plan definitions.
- `creator_subscriptions` — provider subscription state.
- `payment_transactions` — immutable amount/currency/provider/idempotency data.
- `payment_webhook_events` — unique provider event IDs and processing state.
- `creator_payouts` — payout state without enabling payouts.
- `promotion_packages` and `promotion_orders` — paid promotion foundation.
- `digital_product_assets` and `digital_product_orders` — disabled private-delivery foundation.
- `collaboration_campaigns` and `collaboration_offers` — campaign foundation.
- Private `digital-products` Storage bucket with no public read policy.

Browser clients have read-only policies for their own records. Payment,
subscription, activation, payout, and webhook writes require a future trusted
server/webhook worker. `payment_transactions` uses provider references and
idempotency uniqueness to prevent duplicate processing.

## Required future server-only configuration

When a provider is selected, add secrets only to a server or Supabase Edge
Function environment, never to `VITE_*` variables:

- Provider secret/API key.
- Webhook signing secret.
- Provider account/client ID if required.
- Marketplace connected-account/payout configuration.

Before enabling `payments_enabled` or any other feature flag, implement and
test signature verification, idempotent webhook handling, refund handling,
currency-specific fee calculations, creator onboarding, and signed digital
delivery URLs.

## Provider recommendation

Stripe Connect is the strongest first candidate for the marketplace model
because it provides Checkout, Billing, connected accounts, payment intents,
webhook signing, refunds, and payout primitives in one ecosystem. Stripe’s
country and settlement eligibility still depends on HustleHub’s legal entity,
platform country, creator countries, and payout destinations; the current
currency list alone is not enough to approve it.

If HustleHub’s operating entity is primarily in Nigeria or another market where
local settlement is more important than global card coverage, evaluate
Paystack or Flutterwave against the same requirements before choosing. No
provider is connected by this migration.

References:

- https://docs.stripe.com/connect/how-connect-works
- https://docs.stripe.com/connect/cross-border-payouts
- https://docs.stripe.com/currencies
