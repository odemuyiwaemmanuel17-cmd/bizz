-- HustleHub Phase 14: Paystack test-mode hardening.
-- Apply after phase13-paystack-monetization-migration.sql.
-- No live-mode activation is permitted by this migration.

alter table public.monetization_config drop constraint if exists monetization_config_environment_check;
alter table public.monetization_config
  add constraint monetization_config_environment_check check (environment in ('disabled', 'test'));

-- Administrators may inspect inactive plans; ordinary users only see active
-- plans and Free. This keeps plan configuration usable without exposing an
-- ordinary-user write path.
drop policy if exists "public reads active monetization plans" on public.monetization_plans;
create policy "public reads active monetization plans"
  on public.monetization_plans for select
  using (active = true or code = 'free' or public.is_verification_admin());

-- Entitlements are effective only during the verified subscription period.
create or replace function public.has_monetization_entitlement(p_user_id uuid, p_entitlement text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is distinct from p_user_id and not public.is_verification_admin() then
    raise exception 'You may only check your own monetization entitlements.';
  end if;
  return exists (
    select 1
    from public.creator_subscriptions s
    join public.monetization_plans p on p.code = s.plan_code
    where s.creator_id = p_user_id
      and s.status = 'active'
      and (s.current_period_end is null or s.current_period_end > now())
      and coalesce((p.entitlements ->> p_entitlement)::boolean, false)
  );
end;
$$;
revoke all on function public.has_monetization_entitlement(uuid, text) from public;
grant execute on function public.has_monetization_entitlement(uuid, text) to authenticated;

-- This is called by the trusted payment-history endpoint before returning
-- account state. It is deliberately not executable by browser roles.
create or replace function public.expire_due_creator_subscriptions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  expired_count integer;
begin
  update public.creator_subscriptions
  set status = 'expired', updated_at = now()
  where status in ('active', 'past_due')
    and current_period_end is not null
    and current_period_end <= now();
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;
revoke all on function public.expire_due_creator_subscriptions() from public, anon, authenticated;
grant execute on function public.expire_due_creator_subscriptions() to service_role;

-- Only disabled and Paystack test mode are accepted. Live activation remains a
-- separate approved project step and cannot be enabled from this UI/RPC.
create or replace function public.admin_update_monetization_config(
  p_environment text,
  p_provider text,
  p_payments_enabled boolean,
  p_subscriptions_enabled boolean,
  p_paid_promotions_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_verification_admin();
  if p_environment not in ('disabled', 'test') then
    raise exception 'Only disabled or Paystack test mode is permitted.';
  end if;
  if p_provider is not null and lower(trim(p_provider)) <> 'paystack' then
    raise exception 'Paystack is the only configured provider.';
  end if;
  update public.monetization_config
  set environment = p_environment,
      provider = case when p_environment = 'test' then 'paystack' else nullif(trim(coalesce(p_provider, '')), '') end,
      payments_enabled = coalesce(p_payments_enabled, false),
      subscriptions_enabled = coalesce(p_subscriptions_enabled, false),
      paid_promotions_enabled = coalesce(p_paid_promotions_enabled, false),
      updated_at = now()
  where id = 1;
  insert into public.admin_audit_logs(administrator_id, action, entity_type, previous_data, new_data)
  values (
    auth.uid(), 'update_monetization_config', 'monetization_config', '{}'::jsonb,
    jsonb_build_object('environment', p_environment, 'provider', p_provider,
      'paymentsEnabled', p_payments_enabled,
      'subscriptionsEnabled', p_subscriptions_enabled,
      'paidPromotionsEnabled', p_paid_promotions_enabled)
  );
end;
$$;
revoke all on function public.admin_update_monetization_config(text, text, boolean, boolean, boolean) from public;
grant execute on function public.admin_update_monetization_config(text, text, boolean, boolean, boolean) to authenticated;

create or replace function public.process_paystack_event(
  p_event_id text,
  p_event_type text,
  p_reference text,
  p_status text,
  p_amount_cents bigint,
  p_currency text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.payment_webhook_events%rowtype;
  transaction_row public.payment_transactions%rowtype;
  subscription_id uuid;
  renewal_subscription_id uuid;
  promotion_id uuid;
  order_id uuid;
  plan_interval text;
  expected_amount bigint;
  expected_currency text;
  subscription_code text;
  customer_code text;
  refund_id text;
  refund_amount bigint;
  refund_currency text;
  refund_status text;
  next_status text;
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

  if p_event_type in ('charge.success', 'transaction.success') then
    if nullif(trim(coalesce(p_reference, '')), '') is null then
      update public.payment_webhook_events set status = 'ignored', processed_at = now(), error_message = 'Payment reference missing.' where id = event_row.id;
      return jsonb_build_object('ignored', true);
    end if;

    select * into transaction_row
    from public.payment_transactions
    where provider = 'paystack' and provider_reference = p_reference
    for update;

    -- Renewal charge.success events can have a new Paystack reference and no
    -- pre-created local transaction. Reconstruct one only from the existing
    -- verified subscription and its trusted local plan price.
    if transaction_row.id is null then
      subscription_code := coalesce(p_payload #>> '{data,subscription_code}', p_payload #>> '{data,subscription,subscription_code}');
      customer_code := p_payload #>> '{data,customer,customer_code}';
      select s.id into renewal_subscription_id
      from public.creator_subscriptions s
      where s.provider = 'paystack'
        and s.status in ('active', 'past_due')
        and ((subscription_code is not null and s.provider_subscription_id = subscription_code)
          or (customer_code is not null and s.provider_customer_code = customer_code))
      order by s.updated_at desc
      limit 1;

      if renewal_subscription_id is null then
        update public.payment_webhook_events set status = 'ignored', processed_at = now(), error_message = 'No matching local transaction or subscription.' where id = event_row.id;
        return jsonb_build_object('ignored', true);
      end if;

      select p.price_cents, p.currency, p.billing_interval
      into expected_amount, expected_currency, plan_interval
      from public.creator_subscriptions s
      join public.monetization_plans p on p.code = s.plan_code
      where s.id = renewal_subscription_id;

      if expected_amount is null or expected_currency is null or p_amount_cents <> expected_amount or upper(coalesce(p_currency, '')) <> expected_currency then
        update public.payment_webhook_events set status = 'failed', processed_at = now(), error_message = 'Renewal amount or currency mismatch.' where id = event_row.id;
        return jsonb_build_object('failed', true);
      end if;

      insert into public.payment_transactions(
        buyer_id, creator_id, transaction_kind, status, amount_cents, currency,
        platform_fee_cents, creator_net_cents, provider, provider_reference,
        idempotency_key, metadata
      )
      select s.creator_id, s.creator_id, 'subscription', 'pending', expected_amount,
        expected_currency, 0, 0, 'paystack', p_reference, p_reference,
        jsonb_build_object('hustlehub_kind', 'subscription_renewal', 'subscription_id', s.id)
      from public.creator_subscriptions s
      where s.id = renewal_subscription_id
      on conflict (provider, provider_reference) do nothing;

      select * into transaction_row
      from public.payment_transactions
      where provider = 'paystack' and provider_reference = p_reference
      for update;
      subscription_id := renewal_subscription_id;
    end if;

    if transaction_row.status <> 'pending' then
      update public.payment_webhook_events set status = 'processed', processed_at = now(), error_message = 'Transaction already finalized.' where id = event_row.id;
      return jsonb_build_object('duplicate', true);
    end if;

    if (transaction_row.transaction_kind = 'subscription' and coalesce(transaction_row.metadata ->> 'hustlehub_kind', '') not in ('subscription', 'subscription_renewal'))
      or (transaction_row.transaction_kind = 'promotion' and coalesce(transaction_row.metadata ->> 'hustlehub_kind', '') <> 'promotion') then
      update public.payment_webhook_events set status = 'failed', processed_at = now(), error_message = 'Transaction purpose mismatch.' where id = event_row.id;
      return jsonb_build_object('failed', true);
    end if;

    if p_status <> 'success'
      or p_amount_cents <> transaction_row.amount_cents
      or upper(coalesce(p_currency, '')) <> upper(transaction_row.currency) then
      update public.payment_transactions
      set status = 'failed', failure_reason = 'Paystack amount, currency, or status mismatch.', updated_at = now()
      where id = transaction_row.id and status = 'pending';
      update public.payment_webhook_events set status = 'failed', processed_at = now(), error_message = 'Payment verification mismatch.' where id = event_row.id;
      return jsonb_build_object('failed', true);
    end if;

    update public.payment_transactions
    set status = 'succeeded',
        paid_at = coalesce(nullif(p_payload #>> '{data,paid_at}', '')::timestamptz, now()),
        payment_channel = p_payload #>> '{data,channel}',
        provider_customer_code = p_payload #>> '{data,customer,customer_code}',
        provider_subscription_code = coalesce(p_payload #>> '{data,subscription_code}', p_payload #>> '{data,subscription,subscription_code}'),
        updated_at = now()
    where id = transaction_row.id and status = 'pending';

    subscription_id := coalesce(subscription_id, nullif(transaction_row.metadata ->> 'subscription_id', '')::uuid);
    promotion_id := nullif(transaction_row.metadata ->> 'promotion_order_id', '')::uuid;
    order_id := nullif(transaction_row.metadata ->> 'marketplace_order_id', '')::uuid;

    if subscription_id is not null then
      select p.billing_interval into plan_interval
      from public.creator_subscriptions s
      join public.monetization_plans p on p.code = s.plan_code
      where s.id = subscription_id;
      update public.creator_subscriptions
      set status = 'cancelled', updated_at = now()
      where creator_id = transaction_row.buyer_id
        and id <> subscription_id
        and status in ('active', 'pending', 'past_due');
      update public.creator_subscriptions
      set status = 'active',
          current_period_start = now(),
          current_period_end = now() + case when plan_interval = 'year' then interval '1 year' else interval '1 month' end,
          last_payment_at = now(),
          provider = 'paystack',
          provider_subscription_id = coalesce(p_payload #>> '{data,subscription_code}', p_payload #>> '{data,subscription,subscription_code}', provider_subscription_id),
          provider_customer_code = coalesce(p_payload #>> '{data,customer,customer_code}', provider_customer_code),
          provider_authorization_code = coalesce(p_payload #>> '{data,authorization,authorization_code}', provider_authorization_code),
          updated_at = now()
      where id = subscription_id;
    end if;
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

  if p_event_type in ('invoice.payment_failed', 'charge.failed') then
    update public.payment_transactions
    set status = 'failed', failure_reason = coalesce(p_payload #>> '{data,gateway_response}', 'Paystack payment failed'), updated_at = now()
    where provider = 'paystack' and provider_reference = p_reference and status = 'pending';
    subscription_code := coalesce(p_payload #>> '{data,subscription_code}', p_payload #>> '{data,subscription,subscription_code}');
    update public.creator_subscriptions
    set status = 'past_due', updated_at = now()
    where provider = 'paystack' and provider_subscription_id = subscription_code and status = 'active';
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  if p_event_type = 'subscription.create' then
    subscription_code := coalesce(p_payload #>> '{data,subscription_code}', p_payload #>> '{data,subscription,subscription_code}');
    customer_code := p_payload #>> '{data,customer,customer_code}';
    update public.creator_subscriptions
    set provider = 'paystack',
        provider_subscription_id = coalesce(subscription_code, provider_subscription_id),
        provider_customer_code = coalesce(customer_code, provider_customer_code),
        updated_at = now()
    where provider = 'paystack'
      and ((subscription_code is not null and provider_subscription_id = subscription_code)
        or (customer_code is not null and provider_customer_code = customer_code));
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  if p_event_type in ('subscription.not_renew', 'subscription.disable') then
    next_status := case when p_event_type = 'subscription.disable' then 'expired' else 'cancelled' end;
    update public.creator_subscriptions
    set status = next_status, cancel_at_period_end = true, updated_at = now()
    where provider = 'paystack'
      and provider_subscription_id = coalesce(p_payload #>> '{data,subscription_code}', p_payload #>> '{data,subscription,subscription_code}');
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  if p_event_type like 'refund.%' then
    select * into transaction_row
    from public.payment_transactions
    where provider = 'paystack'
      and provider_reference = coalesce(p_reference, p_payload #>> '{data,transaction_reference}')
    for update;
    if transaction_row.id is null then
      update public.payment_webhook_events set status = 'ignored', processed_at = now(), error_message = 'Refund transaction not found.' where id = event_row.id;
      return jsonb_build_object('ignored', true);
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
revoke all on function public.process_paystack_event(text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.process_paystack_event(text, text, text, text, bigint, text, jsonb) to service_role;

notify pgrst, 'reload schema';
