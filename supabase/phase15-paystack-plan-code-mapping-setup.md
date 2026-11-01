# Phase 15 Paystack TEST MODE plan-code mapping

Apply after `phase14-paystack-hardening-migration.sql`:

```text
supabase/phase15-paystack-plan-code-mapping-migration.sql
```

The migration matches stable `monetization_plans.code` identifiers and checks
the confirmed amount, currency, interval, audience, and active state before
updating only `paystack_plan_code` and `updated_at` for the four paid plans.
It does not modify Free, the legacy inactive `pro` record, or any unrelated
record. The existing unique partial index prevents duplicate Paystack plan
codes.

Mapped TEST MODE plans:

| Database code | Paystack code | Currency | Stored minor amount | Interval |
| --- | --- | --- | ---: | --- |
| `pro_monthly` | `PLN_6p9eo2b5a0cnx05` | NGN | 350000 | month |
| `pro_yearly` | `PLN_8wiiuss56fdmw53` | NGN | 3500000 | year |
| `business_monthly` | `PLN_6dlmnyi74htaaeo` | NGN | 1000000 | month |
| `business_yearly` | `PLN_nue9pa3enus4q9n` | NGN | 10000000 | year |

The `PLN_...` values are Paystack plan identifiers, not secret credentials.
Checkout remains unavailable until the existing Paystack webhook and
end-to-end test payment verification are completed. The production
`monetization_config` remains disabled.
