-- HustleHub Phase 17: Paystack plan binding and cross-account ownership hardening.
-- Apply after phase16-enable-paystack-test-monetization.sql.
--
-- TEST MODE ONLY. This migration:
--   * changes no price, Paystack plan code, or plan record;
--   * rewrites no existing transaction, subscription status, or entitlement;
--   * adds verification/reconciliation state, an audit trail for superseded
--     checkouts, a one-user-per-Paystack-customer guard, and a hardened
--     process_paystack_event that binds entitlement to the charged plan.
--
-- Existing rows are left exactly as they are. Rows created before this
-- migration keep status 'pending'; they do not become reconciled, active, or
-- entitled automatically.

begin;

-- ---------------------------------------------------------------------------
-- 1. Auditable states and verification columns
-- ---------------------------------------------------------------------------

alter table public.payment_transactions drop constraint if exists payment_transactions_status_check;
alter table public.payment_transactions add constraint payment_transactions_status_check
  check (status in ('pending', 'succeeded', 'failed', 'refunded', 'cancelled', 'needs_reconciliation'));

alter table public.creator_subscriptions drop constraint if exists creator_subscriptions_status_check;
alter table public.creator_subscriptions add constraint creator_subscriptions_status_check
  check (status in ('incomplete', 'pending', 'active', 'past_due', 'cancelled', 'expired', 'needs_reconciliation'));

alter table public.payment_webhook_events drop constraint if exists payment_webhook_events_status_check;
alter table public.payment_webhook_events add constraint payment_webhook_events_status_check
  check (status in ('received', 'processed', 'ignored', 'failed', 'needs_reconciliation'));

alter table public.payment_transactions
  add column if not exists verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'verified', 'reconciliation_required', 'rejected'));
alter table public.payment_transactions add column if not exists verified_provider_plan_code text;
alter table public.payment_transactions add column if not exists verified_amount_cents bigint;
alter table public.payment_transactions add column if not exists verified_currency text;
alter table public.payment_transactions add column if not exists verified_at timestamptz;
alter table public.payment_transactions add column if not exists reconciliation_reason text;

create index if not exists payment_transactions_reconciliation_idx
  on public.payment_transactions(status, verification_status)
  where status in ('needs_reconciliation', 'failed');

-- Superseded checkout attempts keep their row and gain a reviewable trail.
alter table public.creator_subscriptions add column if not exists provider_plan_code text;
alter table public.creator_subscriptions add column if not exists superseded_at timestamptz;
alter table public.creator_subscriptions add column if not exists superseded_by uuid references public.creator_subscriptions(id) on delete set null;
alter table public.creator_subscriptions add column if not exists superseded_reason text;

-- ---------------------------------------------------------------------------
-- 2. One Paystack customer may never be shared by two HustleHub accounts
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1
    from public.creator_subscriptions s
    where s.provider = 'paystack' and s.provider_customer_code is not null
    group by s.provider_customer_code
    having count(distinct s.creator_id) > 1
  ) then
    raise exception 'Phase 17 precheck failed: one Paystack customer code is attached to more than one HustleHub account. Resolve ownership first with the read-only queries in phase17-paystack-ownership-hardening-setup.md; no rows were modified.';
  end if;
end;
$$;

create or replace function public.enforce_paystack_customer_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.provider_customer_code is not null and new.provider = 'paystack' then
    if exists (
      select 1
      from public.creator_subscriptions s
      where s.provider = 'paystack'
        and s.provider_customer_code = new.provider_customer_code
        and s.creator_id <> new.creator_id
    ) then
      raise exception 'Paystack customer is already linked to another HustleHub account.'
        using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_paystack_customer_owner() from public, anon, authenticated;
drop trigger if exists enforce_paystack_customer_owner on public.creator_subscriptions;
create trigger enforce_paystack_customer_owner
  before insert or update of provider, provider_customer_code on public.creator_subscriptions
  for each row execute function public.enforce_paystack_customer_owner();

-- ---------------------------------------------------------------------------
-- 3. Single outstanding checkout per user, with an audit trail
-- ---------------------------------------------------------------------------

create or replace function public.supersede_pending_checkout(p_user_id uuid, p_reason text default 'Superseded by a newer checkout attempt.')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  superseded jsonb := '[]'::jsonb;
  candidate record;
begin
  -- Only unconfirmed attempts are superseded. 'needs_reconciliation' rows may
  -- represent a real charge awaiting review and are never touched here.
  for candidate in
    select s.id, s.plan_code
    from public.creator_subscriptions s
    where s.creator_id = p_user_id
      and s.status in ('pending', 'incomplete')
    order by s.created_at desc
  loop
    update public.creator_subscriptions
    set status = 'cancelled',
        superseded_at = now(),
        superseded_reason = left(coalesce(p_reason, 'Superseded by a newer checkout attempt.'), 500),
        updated_at = now()
    where id = candidate.id;

    update public.payment_transactions
    set status = 'cancelled',
        failure_reason = coalesce(failure_reason, 'Superseded by a newer checkout attempt.'),
        updated_at = now()
    where buyer_id = p_user_id
      and transaction_kind = 'subscription'
      and status = 'pending'
      and metadata ->> 'subscription_id' = candidate.id::text;

    superseded := superseded || jsonb_build_object('subscription_id', candidate.id, 'plan_code', candidate.plan_code);
  end loop;
  return jsonb_build_object('superseded', superseded, 'count', jsonb_array_length(superseded));
end;
$$;
revoke all on function public.supersede_pending_checkout(uuid, text) from public, anon, authenticated;
grant execute on function public.supersede_pending_checkout(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Hardened Paystack event processing
-- ---------------------------------------------------------------------------

-- The seven-argument version cannot bind a charge to a plan; replace it rather
-- than overload it so a stale caller fails loudly instead of silently passing
-- an unverified charge.
drop function if exists public.process_paystack_event(text, text, text, text, bigint, text, jsonb);

create or replace function public.process_paystack_event(
  p_event_id text,
  p_event_type text,
  p_reference text,
  p_status text,
  p_amount_cents bigint,
  p_currency text,
  p_payload jsonb,
  p_provider_plan_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.payment_webhook_events%rowtype;
  transaction_row public.payment_transactions%rowtype;
  subscription_row record;
  subscription_id uuid;
  renewal_subscription_id uuid;
  renewal_creator_id uuid;
  promotion_id uuid;
  order_id uuid;
  plan_interval text;
  expected_amount bigint;
  expected_currency text;
  stored_customer_code text;
  subscription_code text;
  customer_code text;
  match_count integer;
  reason text;
  refund_id text;
  refund_amount bigint;
  refund_currency text;
  refund_status text;
  next_status text;
  verified_plan jsonb;
begin
  if nullif(trim(coalesce(p_event_id, '')), '') is null then
    raise exception 'Paystack event ID is required.';
  end if;

  insert into public.payment_webhook_events(provider, provider_event_id, event_type, payload_hash, payload, status)
  values (
    'paystack', p_event_id, p_event_type,
    encode(digest(coalesce(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex'),
    coalesce(p_payload, '{}'::jsonb), 'received'
  )
  on conflict (provider, provider_event_id) do nothing
  returning * into event_row;
  if event_row.id is null then
    return jsonb_build_object('duplicate', true);
  end if;

  subscription_code := nullif(coalesce(p_payload #>> '{data,subscription_code}', p_payload #>> '{data,subscription,subscription_code}', ''), '');
  customer_code := nullif(p_payload #>> '{data,customer,customer_code}', '');

  -- -------------------------------------------------------------------------
  -- Successful charges
  -- -------------------------------------------------------------------------
  if p_event_type in ('charge.success', 'transaction.success') then
    if nullif(trim(coalesce(p_reference, '')), '') is null then
      update public.payment_webhook_events set status = 'ignored', processed_at = now(), error_message = 'Payment reference missing.' where id = event_row.id;
      return jsonb_build_object('ignored', true, 'reason', 'reference_missing');
    end if;

    select * into transaction_row
    from public.payment_transactions
    where provider = 'paystack' and provider_reference = p_reference
    for update;

    if transaction_row.id is null then
      -- No local transaction. Only an exact, unique Paystack subscription code
      -- may attribute the charge to an account; a customer code or email can
      -- never create that association.
      if subscription_code is null then
        update public.payment_webhook_events
        set status = 'needs_reconciliation', processed_at = now(),
            error_message = 'unknown_charge: successful charge has no local transaction and no subscription code.'
        where id = event_row.id;
        return jsonb_build_object('reconciliation_required', true, 'reason', 'unknown_charge');
      end if;

      select count(*) into match_count
      from public.creator_subscriptions s
      where s.provider = 'paystack' and s.provider_subscription_id = subscription_code;

      if match_count <> 1 then
        update public.payment_webhook_events
        set status = 'needs_reconciliation', processed_at = now(),
            error_message = 'unknown_renewal: subscription code is not linked to exactly one local subscription.'
        where id = event_row.id;
        return jsonb_build_object('reconciliation_required', true, 'reason', 'unknown_renewal');
      end if;

      select s.id, s.creator_id, s.provider_customer_code
      into renewal_subscription_id, renewal_creator_id, stored_customer_code
      from public.creator_subscriptions s
      where s.provider = 'paystack' and s.provider_subscription_id = subscription_code;

      if customer_code is not null and stored_customer_code is not null and customer_code <> stored_customer_code then
        update public.payment_webhook_events
        set status = 'needs_reconciliation', processed_at = now(),
            error_message = 'renewal_customer_mismatch: Paystack customer does not match the linked subscription owner.'
        where id = event_row.id;
        return jsonb_build_object('reconciliation_required', true, 'reason', 'renewal_customer_mismatch');
      end if;

      select p.price_cents, upper(p.currency)
      into expected_amount, expected_currency
      from public.creator_subscriptions s
      join public.monetization_plans p on p.code = s.plan_code
      where s.id = renewal_subscription_id;

      if expected_amount is null or expected_currency is null
        or p_amount_cents is distinct from expected_amount
        or upper(coalesce(p_currency, '')) is distinct from expected_currency then
        update public.payment_webhook_events
        set status = 'needs_reconciliation', processed_at = now(),
            error_message = 'renewal_amount_mismatch: charge amount or currency does not match the linked plan.'
        where id = event_row.id;
        return jsonb_build_object('reconciliation_required', true, 'reason', 'renewal_amount_mismatch');
      end if;

      insert into public.payment_transactions(
        buyer_id, creator_id, transaction_kind, status, amount_cents, currency,
        platform_fee_cents, creator_net_cents, provider, provider_reference,
        idempotency_key, metadata
      ) values (
        renewal_creator_id, renewal_creator_id, 'subscription', 'pending', p_amount_cents, upper(p_currency),
        0, 0, 'paystack', p_reference, p_reference,
        jsonb_build_object('hustlehub_kind', 'subscription_renewal', 'subscription_id', renewal_subscription_id, 'user_id', renewal_creator_id)
      )
      on conflict (provider, provider_reference) do nothing;

      select * into transaction_row
      from public.payment_transactions
      where provider = 'paystack' and provider_reference = p_reference
      for update;

      if transaction_row.id is null then
        update public.payment_webhook_events
        set status = 'needs_reconciliation', processed_at = now(),
            error_message = 'renewal_transaction_missing: renewal transaction could not be recorded.'
        where id = event_row.id;
        return jsonb_build_object('reconciliation_required', true, 'reason', 'renewal_transaction_missing');
      end if;
      subscription_id := renewal_subscription_id;
    end if;

    if transaction_row.status in ('succeeded', 'refunded') then
      update public.payment_webhook_events set status = 'processed', processed_at = now(), error_message = 'Transaction already finalized.' where id = event_row.id;
      return jsonb_build_object('duplicate', true);
    end if;

    -- A successful charge for an intent that was superseded or previously
    -- failed is real money: flag it for review instead of discarding it.
    if transaction_row.status in ('cancelled', 'failed') and p_status = 'success' then
      update public.payment_transactions
      set status = 'needs_reconciliation',
          verification_status = 'reconciliation_required',
          reconciliation_reason = 'late_charge_on_closed_intent',
          verified_provider_plan_code = p_provider_plan_code,
          verified_amount_cents = p_amount_cents,
          verified_currency = upper(coalesce(p_currency, '')),
          verified_at = now(),
          failure_reason = coalesce(failure_reason, 'Paystack charge arrived after the local payment intent was closed; manual reconciliation required.'),
          metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'verified_paystack_plan_code', p_provider_plan_code,
            'verified_amount_cents', p_amount_cents,
            'verified_currency', upper(coalesce(p_currency, '')),
            'paystack_reference', p_reference,
            'paystack_customer_code', customer_code,
            'paystack_subscription_code', subscription_code),
          updated_at = now()
      where id = transaction_row.id;
      update public.payment_webhook_events
      set status = 'needs_reconciliation', processed_at = now(),
          error_message = 'reconciliation_required: late_charge_on_closed_intent'
      where id = event_row.id;
      return jsonb_build_object('reconciliation_required', true, 'reason', 'late_charge_on_closed_intent');
    end if;

    if transaction_row.status <> 'pending' then
      update public.payment_webhook_events set status = 'processed', processed_at = now(), error_message = 'Transaction already finalized.' where id = event_row.id;
      return jsonb_build_object('duplicate', true);
    end if;

    if (transaction_row.transaction_kind = 'subscription' and coalesce(transaction_row.metadata ->> 'hustlehub_kind', '') not in ('subscription', 'subscription_renewal'))
      or (transaction_row.transaction_kind = 'promotion' and coalesce(transaction_row.metadata ->> 'hustlehub_kind', '') <> 'promotion') then
      update public.payment_webhook_events set status = 'failed', processed_at = now(), error_message = 'Transaction purpose mismatch.' where id = event_row.id;
      return jsonb_build_object('failed', true, 'reason', 'purpose_mismatch');
    end if;

    if p_status is distinct from 'success' then
      update public.payment_transactions
      set status = 'failed', verification_status = 'rejected',
          failure_reason = 'Paystack reported an unsuccessful payment.', updated_at = now()
      where id = transaction_row.id and status = 'pending';
      subscription_id := coalesce(subscription_id, nullif(transaction_row.metadata ->> 'subscription_id', '')::uuid);
      if subscription_id is not null then
        update public.creator_subscriptions set status = 'incomplete', updated_at = now() where id = subscription_id and status = 'pending';
      end if;
      update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
      return jsonb_build_object('failed', true, 'reason', 'status_not_success');
    end if;

    verified_plan := jsonb_build_object(
      'verified_paystack_plan_code', p_provider_plan_code,
      'verified_amount_cents', p_amount_cents,
      'verified_currency', upper(coalesce(p_currency, '')),
      'paystack_reference', p_reference,
      'paystack_customer_code', customer_code,
      'paystack_subscription_code', subscription_code
    );

    if transaction_row.transaction_kind = 'subscription' then
      subscription_id := coalesce(subscription_id, nullif(transaction_row.metadata ->> 'subscription_id', '')::uuid);

      if subscription_id is null then
        reason := 'subscription_reference_missing';
      else
        select s.id, s.creator_id, s.status as subscription_status,
               p.code as plan_code, p.name as plan_name,
               p.price_cents, upper(p.currency) as plan_currency,
               p.billing_interval, p.paystack_plan_code
        into subscription_row
        from public.creator_subscriptions s
        join public.monetization_plans p on p.code = s.plan_code
        where s.id = subscription_id;

        if not found then
          reason := 'subscription_not_found';
        elsif subscription_row.creator_id <> transaction_row.buyer_id then
          reason := 'subscription_owner_mismatch';
        elsif customer_code is not null and exists (
          select 1 from public.creator_subscriptions other
          where other.provider = 'paystack'
            and other.provider_customer_code = customer_code
            and other.creator_id <> transaction_row.buyer_id
        ) then
          reason := 'provider_customer_conflict';
        elsif subscription_row.paystack_plan_code is null then
          reason := 'plan_code_not_configured';
        elsif p_provider_plan_code is null then
          reason := 'paystack_plan_code_missing';
        elsif p_provider_plan_code <> subscription_row.paystack_plan_code then
          reason := 'paystack_plan_mismatch';
        elsif transaction_row.metadata ->> 'plan_code' is not null
          and transaction_row.metadata ->> 'plan_code' <> subscription_row.plan_code then
          reason := 'subscription_plan_mismatch';
        elsif p_amount_cents is distinct from subscription_row.price_cents then
          reason := 'plan_amount_mismatch';
        elsif upper(coalesce(p_currency, '')) is distinct from subscription_row.plan_currency then
          reason := 'plan_currency_mismatch';
        elsif transaction_row.amount_cents <> subscription_row.price_cents then
          reason := 'stale_local_amount';
        elsif subscription_row.billing_interval not in ('month', 'year') then
          reason := 'plan_interval_invalid';
        end if;
      end if;
    else
      if p_amount_cents is distinct from transaction_row.amount_cents then
        reason := 'amount_mismatch';
      elsif upper(coalesce(p_currency, '')) is distinct from upper(transaction_row.currency) then
        reason := 'currency_mismatch';
      end if;
    end if;

    if reason is not null then
      -- A successful charge that does not match the local payment intent is
      -- never discarded and never activates an entitlement: it is parked in a
      -- reviewable reconciliation state with the verified provider values.
      update public.payment_transactions
      set status = 'needs_reconciliation',
          verification_status = 'reconciliation_required',
          reconciliation_reason = reason,
          verified_provider_plan_code = p_provider_plan_code,
          verified_amount_cents = p_amount_cents,
          verified_currency = upper(coalesce(p_currency, '')),
          verified_at = now(),
          failure_reason = coalesce(failure_reason, 'Paystack charge does not match the local payment intent; manual reconciliation required.'),
          metadata = coalesce(metadata, '{}'::jsonb) || verified_plan,
          updated_at = now()
      where id = transaction_row.id;

      if subscription_id is not null then
        update public.creator_subscriptions
        set status = 'needs_reconciliation', updated_at = now()
        where id = subscription_id and status in ('pending', 'incomplete');
      end if;

      update public.payment_webhook_events
      set status = 'needs_reconciliation', processed_at = now(),
          error_message = 'reconciliation_required: ' || reason
      where id = event_row.id;

      return jsonb_build_object('reconciliation_required', true, 'reason', reason);
    end if;

    update public.payment_transactions
    set status = 'succeeded',
        verification_status = 'verified',
        reconciliation_reason = null,
        verified_provider_plan_code = p_provider_plan_code,
        verified_amount_cents = p_amount_cents,
        verified_currency = upper(coalesce(p_currency, '')),
        verified_at = now(),
        paid_at = coalesce(nullif(p_payload #>> '{data,paid_at}', '')::timestamptz, now()),
        payment_channel = p_payload #>> '{data,channel}',
        provider_customer_code = coalesce(customer_code, provider_customer_code),
        provider_subscription_code = coalesce(subscription_code, provider_subscription_code),
        metadata = coalesce(metadata, '{}'::jsonb) || verified_plan,
        updated_at = now()
    where id = transaction_row.id and status = 'pending';

    if subscription_id is not null then
      plan_interval := subscription_row.billing_interval;

      -- Other unconfirmed attempts are superseded with an audit trail. A row
      -- awaiting reconciliation is left untouched for human review.
      update public.creator_subscriptions
      set status = 'cancelled',
          superseded_at = now(),
          superseded_by = subscription_id,
          superseded_reason = 'Replaced by a verified subscription.',
          updated_at = now()
      where creator_id = transaction_row.buyer_id
        and id <> subscription_id
        and status in ('active', 'pending', 'past_due', 'incomplete');

      update public.creator_subscriptions
      set status = 'active',
          current_period_start = now(),
          current_period_end = now() + case when plan_interval = 'year' then interval '1 year' else interval '1 month' end,
          last_payment_at = now(),
          provider = 'paystack',
          provider_plan_code = subscription_row.paystack_plan_code,
          provider_subscription_id = coalesce(subscription_code, provider_subscription_id),
          provider_customer_code = coalesce(customer_code, provider_customer_code),
          provider_authorization_code = coalesce(p_payload #>> '{data,authorization,authorization_code}', provider_authorization_code),
          superseded_at = null,
          superseded_by = null,
          superseded_reason = null,
          updated_at = now()
      where id = subscription_id;
    end if;

    promotion_id := nullif(transaction_row.metadata ->> 'promotion_order_id', '')::uuid;
    order_id := nullif(transaction_row.metadata ->> 'marketplace_order_id', '')::uuid;
    if promotion_id is not null then
      update public.promotion_orders o
      set status = 'active', starts_at = now(), ends_at = now() + make_interval(days => p.duration_days), updated_at = now()
      from public.promotion_packages p
      where o.id = promotion_id and o.package_id = p.id and o.status = 'pending_payment';
    end if;
    if order_id is not null then
      update public.marketplace_orders set status = 'paid', updated_at = now() where id = order_id and status = 'pending_payment';
    end if;

    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  -- -------------------------------------------------------------------------
  -- Failed charges
  -- -------------------------------------------------------------------------
  if p_event_type in ('invoice.payment_failed', 'charge.failed') then
    update public.payment_transactions
    set status = 'failed', verification_status = 'rejected',
        failure_reason = coalesce(p_payload #>> '{data,gateway_response}', 'Paystack payment failed'), updated_at = now()
    where provider = 'paystack' and provider_reference = p_reference and status = 'pending';
    update public.creator_subscriptions
    set status = 'past_due', updated_at = now()
    where provider = 'paystack' and provider_subscription_id = subscription_code and status = 'active';
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  -- -------------------------------------------------------------------------
  -- Subscription lifecycle: exact subscription code only
  -- -------------------------------------------------------------------------
  if p_event_type = 'subscription.create' then
    if subscription_code is null then
      update public.payment_webhook_events set status = 'ignored', processed_at = now(), error_message = 'subscription.create carried no subscription code.' where id = event_row.id;
      return jsonb_build_object('ignored', true, 'reason', 'subscription_code_missing');
    end if;

    select count(*) into match_count
    from public.creator_subscriptions s
    where s.provider = 'paystack' and s.provider_subscription_id = subscription_code;

    if match_count = 0 then
      -- First charge ordering: Paystack emits subscription.create before
      -- charge.success. Linkage is completed by charge.success using the local
      -- transaction reference; no user is inferred from customer data.
      update public.payment_webhook_events
      set status = 'ignored', processed_at = now(),
          error_message = 'subscription.create arrived before charge verification; linkage is completed by charge.success.'
      where id = event_row.id;
      return jsonb_build_object('ignored', true, 'reason', 'subscription_not_yet_linked');
    end if;

    if match_count > 1 then
      update public.payment_webhook_events
      set status = 'needs_reconciliation', processed_at = now(),
          error_message = 'subscription.create: subscription code matches more than one local subscription.'
      where id = event_row.id;
      return jsonb_build_object('reconciliation_required', true, 'reason', 'subscription_ambiguous');
    end if;

    select s.id, s.creator_id, s.provider_customer_code, p.paystack_plan_code
    into subscription_row
    from public.creator_subscriptions s
    join public.monetization_plans p on p.code = s.plan_code
    where s.provider = 'paystack' and s.provider_subscription_id = subscription_code;

    if not found then
      update public.payment_webhook_events
      set status = 'needs_reconciliation', processed_at = now(),
          error_message = 'subscription.create: linked subscription has no local plan record.'
      where id = event_row.id;
      return jsonb_build_object('reconciliation_required', true, 'reason', 'subscription_plan_missing');
    end if;

    if p_provider_plan_code is not null
      and subscription_row.paystack_plan_code is not null
      and p_provider_plan_code <> subscription_row.paystack_plan_code then
      update public.payment_webhook_events
      set status = 'needs_reconciliation', processed_at = now(),
          error_message = 'subscription.create: Paystack plan does not match the local plan.'
      where id = event_row.id;
      return jsonb_build_object('reconciliation_required', true, 'reason', 'paystack_plan_mismatch');
    end if;

    if customer_code is not null and exists (
      select 1 from public.creator_subscriptions other
      where other.provider = 'paystack'
        and other.provider_customer_code = customer_code
        and other.creator_id <> subscription_row.creator_id
    ) then
      update public.payment_webhook_events
      set status = 'needs_reconciliation', processed_at = now(),
          error_message = 'subscription.create: Paystack customer is linked to another account.'
      where id = event_row.id;
      return jsonb_build_object('reconciliation_required', true, 'reason', 'provider_customer_conflict');
    end if;

    update public.creator_subscriptions
    set provider = 'paystack',
        provider_customer_code = coalesce(customer_code, provider_customer_code),
        provider_plan_code = coalesce(subscription_row.paystack_plan_code, provider_plan_code),
        updated_at = now()
    where id = subscription_row.id;

    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  if p_event_type in ('subscription.not_renew', 'subscription.disable') then
    next_status := case when p_event_type = 'subscription.disable' then 'expired' else 'cancelled' end;
    update public.creator_subscriptions
    set status = next_status, cancel_at_period_end = true, updated_at = now()
    where provider = 'paystack'
      and provider_subscription_id = subscription_code;
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  -- -------------------------------------------------------------------------
  -- Refunds
  -- -------------------------------------------------------------------------
  if p_event_type like 'refund.%' then
    select * into transaction_row
    from public.payment_transactions
    where provider = 'paystack'
      and provider_reference = coalesce(p_reference, p_payload #>> '{data,transaction_reference}')
    for update;
    if transaction_row.id is null then
      update public.payment_webhook_events set status = 'ignored', processed_at = now(), error_message = 'Refund transaction not found.' where id = event_row.id;
      return jsonb_build_object('ignored', true, 'reason', 'refund_transaction_not_found');
    end if;
    refund_id := coalesce(p_payload #>> '{data,id}', p_payload #>> '{data,refund_id}');
    refund_amount := coalesce(nullif(p_payload #>> '{data,amount}', '')::bigint, transaction_row.amount_cents);
    refund_currency := upper(coalesce(nullif(p_payload #>> '{data,currency}', ''), transaction_row.currency));
    refund_status := case
      when p_event_type = 'refund.processed' then 'processed'
      when p_event_type = 'refund.failed' then 'failed'
      when p_event_type = 'refund.processing' then 'processing'
      else 'pending'
    end;
    insert into public.payment_refunds(transaction_id, provider, provider_refund_id, amount_cents, currency, status, reason)
    values (transaction_row.id, 'paystack', refund_id, refund_amount, refund_currency, refund_status, p_payload #>> '{data,reason}')
    on conflict (provider, provider_refund_id) do update
      set status = excluded.status, reason = excluded.reason, updated_at = now();
    if p_event_type = 'refund.processed' then
      update public.payment_transactions set status = 'refunded', refunded_at = now(), updated_at = now() where id = transaction_row.id;
      subscription_id := nullif(transaction_row.metadata ->> 'subscription_id', '')::uuid;
      if subscription_id is not null then
        update public.creator_subscriptions set status = 'expired', cancel_at_period_end = true, updated_at = now() where id = subscription_id;
      end if;
    end if;
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  update public.payment_webhook_events set status = 'ignored', processed_at = now() where id = event_row.id;
  return jsonb_build_object('ignored', true);
exception when others then
  update public.payment_webhook_events set status = 'failed', processed_at = now(), error_message = sqlerrm where id = event_row.id;
  raise;
end;
$$;

revoke all on function public.process_paystack_event(text, text, text, text, bigint, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.process_paystack_event(text, text, text, text, bigint, text, jsonb, text) to service_role;

notify pgrst, 'reload schema';

commit;
