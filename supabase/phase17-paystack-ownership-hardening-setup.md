# Phase 17 Paystack plan binding and ownership hardening

Apply after `phase16-enable-paystack-test-monetization.sql`:

```text
supabase/phase17-paystack-ownership-hardening-migration.sql
```

The migration runs in a single transaction, keeps Paystack in **test mode**, and
does **not** change any price, Paystack plan code, plan record, transaction,
subscription status, or entitlement. Existing rows are preserved exactly; rows
created before this migration are not retroactively verified or activated.

## What changes in the database

| Change | Purpose |
| --- | --- |
| `payment_transactions.verification_status`, `verified_provider_plan_code`, `verified_amount_cents`, `verified_currency`, `verified_at`, `reconciliation_reason` | Records what Paystack actually charged next to what HustleHub expected. |
| `payment_transactions.status` gains `needs_reconciliation` | A successful charge that does not match the local intent is parked for review instead of being discarded or left as an unexplained `pending`. |
| `creator_subscriptions.status` gains `needs_reconciliation` | An unconfirmed subscription whose charge diverged is never shown as a plan and never grants an entitlement (`has_monetization_entitlement` still requires `active`). |
| `creator_subscriptions.provider_plan_code`, `superseded_at`, `superseded_by`, `superseded_reason` | Audit trail for the plan a subscription was opened against and for replaced checkout attempts. |
| `payment_webhook_events.status` gains `needs_reconciliation` | Unmatched or divergent events stay visible and reviewable. |
| `enforce_paystack_customer_owner` trigger | One Paystack customer code can never be attached to rows of two HustleHub accounts. |
| `supersede_pending_checkout(uuid, text)` (service role only) | Cancels unconfirmed attempts with a trail when a new checkout starts. `needs_reconciliation` rows are never superseded. |
| hardened `process_paystack_event(..., p_provider_plan_code)` | Binds entitlement to the charged plan, requires a matching customer, and stops customer-code-only attribution. |

The seven-argument `process_paystack_event` is dropped, not overloaded, so any
stale caller fails loudly instead of passing an unverified charge. Deploy the
updated API functions together with this migration.

## Precheck

The migration aborts with a clear message and changes nothing if an existing
Paystack customer code is already attached to more than one HustleHub account.
Resolve that with the read-only queries below before applying.

```sql
-- Accounts and their provider identity
select s.id, s.creator_id, u.email, s.plan_code, s.status,
       s.provider_customer_code, s.provider_subscription_id, s.provider_plan_code,
       s.created_at, s.updated_at
from public.creator_subscriptions s
join auth.users u on u.id = s.creator_id
order by s.created_at;

-- Shared customer codes (must return no rows)
select provider_customer_code, count(distinct creator_id), array_agg(distinct creator_id)
from public.creator_subscriptions
where provider = 'paystack' and provider_customer_code is not null
group by provider_customer_code having count(distinct creator_id) > 1;

-- Charges awaiting review after the migration
select t.provider_reference, t.status, t.verification_status, t.reconciliation_reason,
       t.verified_provider_plan_code, t.verified_amount_cents, t.verified_currency,
       t.metadata ->> 'plan_code' as expected_plan_code, t.created_at
from public.payment_transactions t
where t.status = 'needs_reconciliation'
order by t.created_at desc;

-- Webhook events awaiting review
select provider_event_id, event_type, status, error_message, received_at
from public.payment_webhook_events
where status = 'needs_reconciliation'
order by received_at desc;
```

## Verification rules now enforced

A subscription charge activates only when all of the following hold against
authoritative database rows:

1. the local transaction reference matches and the transaction is still `pending`;
2. the subscription belongs to the transaction buyer (`buyer_id`);
3. the subscription plan has a configured `paystack_plan_code`;
4. the Paystack plan code reported for the charge equals that plan code;
5. the charged amount equals the plan's `price_cents`;
6. the charged currency equals the plan currency;
7. the transaction amount equals the plan price (no stale local amount);
8. the plan has a monthly or annual billing interval;
9. the Paystack customer code is not already attached to another account.

Any other outcome sets `payment_transactions.status = 'needs_reconciliation'`,
records `reconciliation_reason` plus the verified provider values, leaves the
entitlement inactive, and marks the webhook event for review. The webhook
answers `200` for that state so Paystack stops retrying an already-recorded
charge, and `500` for genuine processing faults so retries continue.

Renewal charges with no local transaction are attributed only by an exact,
unique Paystack `subscription_code` (a customer code may only confirm the link).
Anything else is recorded as `needs_reconciliation` without granting access.

## Rollout order

1. Review the precheck queries (read-only).
2. Apply the migration in the Supabase SQL editor (test project first).
3. Deploy the updated `web/api/paystack/*.mjs` handlers together with it.
4. Confirm `monetization_config.environment = 'test'` and
   `paid_promotions_enabled = false`.
5. Register the webhook URL and verify a signed test event reaches
   `payment_webhook_events` with status `processed`.
6. Only then run a controlled test transaction.

Live payments remain impossible: `monetization_config_environment_check` and
`enabledConfig` still accept only `disabled` or `test`.
