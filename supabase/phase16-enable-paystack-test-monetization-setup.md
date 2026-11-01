# Phase 16 Paystack test provider activation

The existing `public.monetization_config` row is configured as:

```text
provider = paystack
environment = test
payments_enabled = true
subscriptions_enabled = true
paid_promotions_enabled = false
```

Only the existing configuration row was updated. No keys, plan records, or
payment records were changed. Live mode remains blocked by Phase 14.
