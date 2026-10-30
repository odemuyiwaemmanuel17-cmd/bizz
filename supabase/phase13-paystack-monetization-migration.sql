-- HustleHub Phase 13: Paystack freemium subscriptions and monetization.
-- Apply after phase12-admin-schema-alignment-migration.sql.
--
-- This migration creates the server-facing Paystack lifecycle contract. The
-- default environment remains disabled, so no browser can initialize a real
-- charge until Paystack test credentials, webhook configuration, and an owner
-- explicitly enable test mode.

create extension if not exists pgcrypto;

-- -------------------------------------------------------------------------
-- Plan, subscription, payment, refund, promotion, and commission metadata
-- -------------------------------------------------------------------------

alter table public.monetization_plans add column if not exists audience text not null default 'creator';
alter table public.monetization_plans add column if not exists paystack_plan_code text;
alter table public.monetization_plans add column if not exists display_order integer not null default 0;
alter table public.monetization_plans drop constraint if exists monetization_plans_audience_check;
alter table public.monetization_plans add constraint monetization_plans_audience_check check (audience in ('all', 'creator', 'business'));
create unique index if not exists monetization_plans_paystack_code_idx on public.monetization_plans(paystack_plan_code) where paystack_plan_code is not null;

update public.monetization_plans
set audience = 'all', display_order = 0,
    entitlements = coalesce(entitlements, '{}'::jsonb) || '{"profile":true,"bizzes":true,"videos":true,"ideas":true,"validation":true,"social":true,"basic_analytics":true}'::jsonb
where code = 'free';

insert into public.monetization_plans (code, name, description, active, price_cents, currency, billing_interval, audience, display_order, entitlements)
values
  ('pro_monthly', 'HustleHub Pro', 'Advanced creator analytics and growth tools.', true, 350000, 'NGN', 'month', 'creator', 10, '{"advanced_analytics":true,"profile_customization":true,"audience_insights":true,"promotion_tools":true,"priority_discovery":true,"paid_plan_badge":true}'::jsonb),
  ('pro_yearly', 'HustleHub Pro Annual', 'HustleHub Pro billed annually at a configurable price.', true, 3500000, 'NGN', 'year', 'creator', 11, '{"advanced_analytics":true,"profile_customization":true,"audience_insights":true,"promotion_tools":true,"priority_discovery":true,"paid_plan_badge":true}'::jsonb),
  ('business_monthly', 'HustleHub Business', 'Advanced business analytics and listing growth tools.', true, 1000000, 'NGN', 'month', 'business', 20, '{"advanced_analytics":true,"business_analytics":true,"listing_management":true,"campaign_tools":true,"promotion_tools":true,"business_profile":true}'::jsonb),
  ('business_yearly', 'HustleHub Business Annual', 'HustleHub Business billed annually at a configurable price.', true, 10000000, 'NGN', 'year', 'business', 21, '{"advanced_analytics":true,"business_analytics":true,"listing_management":true,"campaign_tools":true,"promotion_tools":true,"business_profile":true}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  audience = excluded.audience,
  display_order = excluded.display_order,
  entitlements = excluded.entitlements;

alter table public.monetization_plans enable row level security;
drop policy if exists "authenticated users read monetization plans" on public.monetization_plans;
drop policy if exists "public reads active monetization plans" on public.monetization_plans;
create policy "public reads active monetization plans"
  on public.monetization_plans for select
  using (active = true or code = 'free');

alter table public.creator_subscriptions add column if not exists provider_customer_code text;
alter table public.creator_subscriptions add column if not exists provider_authorization_code text;
alter table public.creator_subscriptions add column if not exists provider_subscription_code text;
alter table public.creator_subscriptions add column if not exists last_payment_at timestamptz;
alter table public.creator_subscriptions add column if not exists cancel_requested_at timestamptz;
create unique index if not exists creator_subscriptions_provider_code_idx on public.creator_subscriptions(provider, provider_subscription_id) where provider_subscription_id is not null;
create index if not exists creator_subscriptions_current_idx on public.creator_subscriptions(creator_id, status, updated_at desc);

alter table public.payment_transactions add column if not exists provider_customer_code text;
alter table public.payment_transactions add column if not exists provider_subscription_code text;
alter table public.payment_transactions add column if not exists payment_channel text;
alter table public.payment_transactions add column if not exists failure_reason text;
alter table public.payment_transactions add column if not exists paid_at timestamptz;
alter table public.payment_transactions add column if not exists refunded_at timestamptz;
alter table public.payment_transactions add column if not exists receipt_url text;
create index if not exists payment_transactions_reference_idx on public.payment_transactions(provider, provider_reference);

alter table public.payment_webhook_events add column if not exists payload jsonb not null default '{}'::jsonb;
create index if not exists payment_webhook_events_received_idx on public.payment_webhook_events(received_at desc);

create table if not exists public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.payment_transactions(id) on delete restrict,
  provider text not null,
  provider_refund_id text,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('pending', 'processing', 'needs_attention', 'processed', 'failed')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_refund_id)
);
create index if not exists payment_refunds_status_idx on public.payment_refunds(status, created_at desc);
alter table public.payment_refunds enable row level security;
drop policy if exists "participants read payment refunds" on public.payment_refunds;
create policy "participants read payment refunds"
  on public.payment_refunds for select
  using (exists (
    select 1 from public.payment_transactions t
    where t.id = transaction_id
      and (t.buyer_id = auth.uid() or t.creator_id = auth.uid() or public.is_verification_admin())
  ));

create table if not exists public.monetization_commission_config (
  id integer primary key check (id = 1),
  marketplace_rate_bps integer not null default 1000 check (marketplace_rate_bps between 0 and 10000),
  promotion_rate_bps integer not null default 0 check (promotion_rate_bps between 0 and 10000),
  updated_at timestamptz not null default now()
);
insert into public.monetization_commission_config(id) values (1) on conflict (id) do nothing;
alter table public.monetization_commission_config enable row level security;
drop policy if exists "admins read commission config" on public.monetization_commission_config;
create policy "admins read commission config" on public.monetization_commission_config for select using (public.is_verification_admin());

create table if not exists public.marketplace_orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.profiles(id) on delete restrict,
  seller_id uuid not null references public.profiles(id) on delete restrict,
  listing_id uuid not null references public.listings(id) on delete restrict,
  transaction_id uuid unique references public.payment_transactions(id) on delete set null,
  status text not null check (status in ('pending_payment', 'paid', 'cancelled', 'refunded', 'failed')),
  amount_cents bigint not null check (amount_cents >= 0),
  platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0 and platform_fee_cents <= amount_cents),
  seller_net_cents bigint not null default 0 check (seller_net_cents >= 0 and seller_net_cents <= amount_cents),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketplace_orders_buyer_idx on public.marketplace_orders(buyer_id, created_at desc);
create index if not exists marketplace_orders_seller_idx on public.marketplace_orders(seller_id, created_at desc);
alter table public.marketplace_orders enable row level security;
drop policy if exists "participants read marketplace orders" on public.marketplace_orders;
create policy "participants read marketplace orders" on public.marketplace_orders for select using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_verification_admin());

-- Ensure every account has a free subscription record. This is an entitlement
-- record, not a payment record and grants no premium features.
create or replace function public.ensure_free_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.monetization_plans where code = 'free' and active = true)
     and not exists (select 1 from public.creator_subscriptions where creator_id = new.id and status in ('active', 'pending', 'past_due')) then
    insert into public.creator_subscriptions(creator_id, plan_code, status, provider)
    values (new.id, 'free', 'active', 'internal');
  end if;
  return new;
end;
$$;
drop trigger if exists assign_free_subscription on public.profiles;
create trigger assign_free_subscription after insert on public.profiles for each row execute function public.ensure_free_subscription();
insert into public.creator_subscriptions(creator_id, plan_code, status, provider)
select p.id, 'free', 'active', 'internal'
from public.profiles p
where not exists (select 1 from public.creator_subscriptions s where s.creator_id = p.id and s.status in ('active', 'pending', 'past_due'))
on conflict do nothing;

-- -------------------------------------------------------------------------
-- Server-only entitlement and Paystack event functions
-- -------------------------------------------------------------------------

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
      and coalesce((p.entitlements ->> p_entitlement)::boolean, false)
  );
end;
$$;
revoke all on function public.has_monetization_entitlement(uuid, text) from public;
grant execute on function public.has_monetization_entitlement(uuid, text) to authenticated;

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
  promotion_id uuid;
  order_id uuid;
  plan_interval text;
  next_status text;
begin
  if nullif(trim(coalesce(p_event_id, '')), '') is null then raise exception 'Paystack event ID is required.'; end if;
  insert into public.payment_webhook_events(provider, provider_event_id, event_type, payload_hash, payload, status)
  values ('paystack', p_event_id, p_event_type, encode(digest(coalesce(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex'), coalesce(p_payload, '{}'::jsonb), 'received')
  on conflict (provider, provider_event_id) do nothing
  returning * into event_row;
  if event_row.id is null then return jsonb_build_object('duplicate', true); end if;

  if p_event_type in ('charge.success', 'transaction.success') then
    select * into transaction_row from public.payment_transactions where provider = 'paystack' and provider_reference = p_reference for update;
    if transaction_row.id is null then
      update public.payment_webhook_events set status = 'ignored', processed_at = now(), error_message = 'No matching local transaction.' where id = event_row.id;
      return jsonb_build_object('ignored', true);
    end if;
    if p_status <> 'success' or p_amount_cents <> transaction_row.amount_cents or upper(coalesce(p_currency, '')) <> transaction_row.currency then
      update public.payment_transactions set status = 'failed', failure_reason = 'Paystack amount, currency, or status mismatch.', updated_at = now() where id = transaction_row.id and status = 'pending';
      update public.payment_webhook_events set status = 'failed', processed_at = now(), error_message = 'Payment verification mismatch.' where id = event_row.id;
      return jsonb_build_object('failed', true);
    end if;
    update public.payment_transactions
    set status = 'succeeded', paid_at = coalesce(nullif(p_payload #>> '{data,paid_at}', '')::timestamptz, now()), payment_channel = p_payload #>> '{data,channel}', provider_customer_code = p_payload #>> '{data,customer,customer_code}', provider_subscription_code = p_payload #>> '{data,subscription,subscription_code}', metadata = metadata || coalesce(p_payload #> '{data}', '{}'::jsonb), updated_at = now()
    where id = transaction_row.id;
    subscription_id := nullif(transaction_row.metadata ->> 'subscription_id', '')::uuid;
    promotion_id := nullif(transaction_row.metadata ->> 'promotion_order_id', '')::uuid;
    order_id := nullif(transaction_row.metadata ->> 'marketplace_order_id', '')::uuid;
    if subscription_id is not null then
      select p.billing_interval into plan_interval from public.creator_subscriptions s join public.monetization_plans p on p.code = s.plan_code where s.id = subscription_id;
      update public.creator_subscriptions set status = 'cancelled', updated_at = now() where creator_id = transaction_row.buyer_id and id <> subscription_id and status in ('active', 'pending', 'past_due');
      update public.creator_subscriptions set status = 'active', current_period_start = now(), current_period_end = now() + case when plan_interval = 'year' then interval '1 year' else interval '1 month' end, last_payment_at = now(), provider = 'paystack', provider_subscription_id = coalesce(p_payload #>> '{data,subscription,subscription_code}', provider_subscription_id), provider_customer_code = p_payload #>> '{data,customer,customer_code}', provider_authorization_code = p_payload #>> '{data,authorization,authorization_code}', updated_at = now() where id = subscription_id;
    end if;
    if promotion_id is not null then
      update public.promotion_orders o set status = 'active', starts_at = now(), ends_at = now() + make_interval(days => p.duration_days), updated_at = now() from public.promotion_packages p where o.id = promotion_id and o.package_id = p.id;
    end if;
    if order_id is not null then update public.marketplace_orders set status = 'paid', updated_at = now() where id = order_id; end if;
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  if p_event_type in ('invoice.payment_failed', 'charge.failed') then
    update public.payment_transactions set status = 'failed', failure_reason = coalesce(p_payload #>> '{data,gateway_response}', 'Paystack payment failed'), updated_at = now() where provider = 'paystack' and provider_reference = p_reference and status = 'pending';
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  if p_event_type in ('subscription.not_renew', 'subscription.disable') then
    next_status := case when p_event_type = 'subscription.disable' then 'expired' else 'cancelled' end;
    update public.creator_subscriptions set status = next_status, cancel_at_period_end = true, updated_at = now() where provider = 'paystack' and provider_subscription_id = coalesce(p_payload #>> '{data,subscription_code}', p_payload #>> '{data,subscription,subscription_code}');
    update public.payment_webhook_events set status = 'processed', processed_at = now() where id = event_row.id;
    return jsonb_build_object('processed', true);
  end if;

  if p_event_type like 'refund.%' then
    update public.payment_transactions set status = case when p_event_type = 'refund.processed' then 'refunded' else status end, refunded_at = case when p_event_type = 'refund.processed' then now() else refunded_at end, updated_at = now() where provider = 'paystack' and provider_reference = coalesce(p_reference, p_payload #>> '{data,transaction_reference}');
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

-- -------------------------------------------------------------------------
-- Administrator configuration and transaction inspection
-- -------------------------------------------------------------------------

create or replace function public.admin_update_monetization_config(
  p_environment text,
  p_provider text,
  p_payments_enabled boolean,
  p_subscriptions_enabled boolean,
  p_paid_promotions_enabled boolean
)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_verification_admin();
  if p_environment not in ('disabled', 'test', 'live') then raise exception 'Invalid monetization environment.'; end if;
  update public.monetization_config set environment = p_environment, provider = nullif(trim(coalesce(p_provider, '')), ''), payments_enabled = coalesce(p_payments_enabled, false), subscriptions_enabled = coalesce(p_subscriptions_enabled, false), paid_promotions_enabled = coalesce(p_paid_promotions_enabled, false), updated_at = now() where id = 1;
  insert into public.admin_audit_logs(administrator_id, action, entity_type, previous_data, new_data) values (auth.uid(), 'update_monetization_config', 'monetization_config', '{}'::jsonb, jsonb_build_object('environment', p_environment, 'provider', p_provider, 'paymentsEnabled', p_payments_enabled, 'subscriptionsEnabled', p_subscriptions_enabled, 'paidPromotionsEnabled', p_paid_promotions_enabled));
end;
$$;
revoke all on function public.admin_update_monetization_config(text, text, boolean, boolean, boolean) from public;
grant execute on function public.admin_update_monetization_config(text, text, boolean, boolean, boolean) to authenticated;

create or replace function public.admin_update_monetization_plan(p_code text, p_name text, p_description text, p_active boolean, p_price_cents bigint, p_currency text, p_billing_interval text, p_entitlements jsonb, p_paystack_plan_code text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_verification_admin();
  update public.monetization_plans set name = trim(p_name), description = trim(p_description), active = p_active, price_cents = p_price_cents, currency = upper(p_currency), billing_interval = p_billing_interval, entitlements = coalesce(p_entitlements, '{}'::jsonb), paystack_plan_code = nullif(trim(coalesce(p_paystack_plan_code, '')), ''), updated_at = now() where code = p_code;
  if not found then raise exception 'Plan not found.'; end if;
  insert into public.admin_audit_logs(administrator_id, action, entity_type, new_data) values (auth.uid(), 'update_monetization_plan', 'monetization_plan', jsonb_build_object('code', p_code, 'active', p_active, 'priceCents', p_price_cents, 'currency', p_currency, 'billingInterval', p_billing_interval));
end;
$$;
revoke all on function public.admin_update_monetization_plan(text, text, text, boolean, bigint, text, text, jsonb, text) from public;
grant execute on function public.admin_update_monetization_plan(text, text, text, boolean, bigint, text, text, jsonb, text) to authenticated;

create or replace function public.admin_update_commission_config(p_marketplace_rate_bps integer, p_promotion_rate_bps integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_verification_admin();
  update public.monetization_commission_config set marketplace_rate_bps = p_marketplace_rate_bps, promotion_rate_bps = p_promotion_rate_bps, updated_at = now() where id = 1;
  insert into public.admin_audit_logs(administrator_id, action, entity_type, new_data) values (auth.uid(), 'update_commission_config', 'commission_config', jsonb_build_object('marketplaceRateBps', p_marketplace_rate_bps, 'promotionRateBps', p_promotion_rate_bps));
end;
$$;
revoke all on function public.admin_update_commission_config(integer, integer) from public;
grant execute on function public.admin_update_commission_config(integer, integer) to authenticated;

create or replace function public.admin_list_payment_transactions(p_search text default null, p_status text default null, p_kind text default null, p_from timestamptz default null, p_to timestamptz default null, p_page integer default 0, p_page_size integer default 25)
returns table (id uuid, buyer_id uuid, creator_id uuid, transaction_kind text, status text, amount_cents bigint, currency text, platform_fee_cents bigint, creator_net_cents bigint, provider text, provider_reference text, failure_reason text, created_at timestamptz, total_count bigint)
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_verification_admin();
  return query select t.id, t.buyer_id, t.creator_id, t.transaction_kind, t.status, t.amount_cents, t.currency, t.platform_fee_cents, t.creator_net_cents, t.provider, t.provider_reference, t.failure_reason, t.created_at, count(*) over() from public.payment_transactions t where (nullif(trim(coalesce(p_search, '')), '') is null or t.id::text = trim(p_search) or lower(coalesce(t.provider_reference, '')) like '%' || lower(trim(p_search)) || '%') and (p_status is null or t.status = p_status) and (p_kind is null or t.transaction_kind = p_kind) and (p_from is null or t.created_at >= p_from) and (p_to is null or t.created_at < p_to) order by t.created_at desc offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100) limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_payment_transactions(text, text, text, timestamptz, timestamptz, integer, integer) from public;
grant execute on function public.admin_list_payment_transactions(text, text, text, timestamptz, timestamptz, integer, integer) to authenticated;

notify pgrst, 'reload schema';
