-- HustleHub Phase 10: monetization foundations.
--
-- This migration creates auditable payment, plan, promotion, digital-product,
-- campaign, and payout records without enabling real checkout. There is no
-- payment provider or server-side webhook endpoint in the current application,
-- so all payment/activation writes remain unavailable to browser clients.
-- Apply after creator-verification-admin-migration.sql.

create extension if not exists pgcrypto;

-- -------------------------------------------------------------------------
-- Owner-controlled feature configuration and plan definitions
-- -------------------------------------------------------------------------

create table if not exists public.monetization_config (
  id integer primary key check (id = 1),
  environment text not null default 'disabled' check (environment in ('disabled', 'test', 'live')),
  provider text,
  payments_enabled boolean not null default false,
  subscriptions_enabled boolean not null default false,
  paid_promotions_enabled boolean not null default false,
  digital_products_enabled boolean not null default false,
  collaborations_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.monetization_config (id)
values (1)
on conflict (id) do nothing;
alter table public.monetization_config enable row level security;
drop policy if exists "authenticated users read monetization config" on public.monetization_config;
create policy "authenticated users read monetization config"
  on public.monetization_config for select to authenticated using (true);

create table if not exists public.monetization_plans (
  code text primary key check (code ~ '^[a-z0-9_]+$'),
  name text not null,
  description text not null,
  active boolean not null default false,
  price_cents bigint check (price_cents is null or price_cents >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  billing_interval text check (billing_interval is null or billing_interval in ('month', 'year')),
  entitlements jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.monetization_plans (code, name, description, active, entitlements)
values
  ('free', 'Free', 'Core HustleHub creator tools.', true, '{"analytics":true,"profile":true,"bizzes":true,"videos":true}'::jsonb),
  ('pro', 'HustleHub Pro', 'Optional expanded creator tools. Pricing and billing are not configured.', false, '{}'::jsonb)
on conflict (code) do nothing;
alter table public.monetization_plans enable row level security;
drop policy if exists "authenticated users read monetization plans" on public.monetization_plans;
create policy "authenticated users read monetization plans"
  on public.monetization_plans for select to authenticated using (active = true or code = 'free');

-- -------------------------------------------------------------------------
-- Payment, subscription, and payout records
-- -------------------------------------------------------------------------

create table if not exists public.creator_subscriptions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  plan_code text not null references public.monetization_plans(code),
  status text not null check (status in ('incomplete', 'pending', 'active', 'past_due', 'cancelled', 'expired')),
  provider text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
alter table public.creator_subscriptions enable row level security;
drop policy if exists "creators read own subscriptions" on public.creator_subscriptions;
create policy "creators read own subscriptions"
  on public.creator_subscriptions for select
  using (creator_id = auth.uid() or public.is_verification_admin());

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid references public.profiles(id) on delete set null,
  creator_id uuid references public.profiles(id) on delete set null,
  transaction_kind text not null check (transaction_kind in ('promotion', 'subscription', 'digital_product', 'collaboration')),
  status text not null check (status in ('pending', 'succeeded', 'failed', 'refunded', 'cancelled')),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0 and platform_fee_cents <= amount_cents),
  creator_net_cents bigint not null default 0 check (creator_net_cents >= 0 and creator_net_cents <= amount_cents),
  provider text,
  provider_reference text,
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_reference),
  unique (provider, idempotency_key)
);
create index if not exists payment_transactions_status_idx on public.payment_transactions(status, created_at desc);
create index if not exists payment_transactions_creator_idx on public.payment_transactions(creator_id, created_at desc);
alter table public.payment_transactions enable row level security;
drop policy if exists "users read participating transactions" on public.payment_transactions;
create policy "users read participating transactions"
  on public.payment_transactions for select
  using (buyer_id = auth.uid() or creator_id = auth.uid() or public.is_verification_admin());

create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  payload_hash text not null,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);
alter table public.payment_webhook_events enable row level security;
drop policy if exists "admins read payment webhook events" on public.payment_webhook_events;
create policy "admins read payment webhook events"
  on public.payment_webhook_events for select
  using (public.is_verification_admin());

create table if not exists public.creator_payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  transaction_id uuid references public.payment_transactions(id) on delete set null,
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  provider text,
  provider_reference text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists creator_payouts_status_idx on public.creator_payouts(status, created_at desc);
alter table public.creator_payouts enable row level security;
drop policy if exists "creators read own payouts" on public.creator_payouts;
create policy "creators read own payouts"
  on public.creator_payouts for select
  using (creator_id = auth.uid() or public.is_verification_admin());

-- -------------------------------------------------------------------------
-- Paid promotion packages and orders
-- -------------------------------------------------------------------------

create table if not exists public.promotion_packages (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  placement text not null check (placement in ('discover_featured', 'category_featured', 'profile_featured')),
  duration_days integer not null check (duration_days > 0),
  price_cents bigint not null check (price_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  terms text not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.promotion_packages enable row level security;
drop policy if exists "users read active promotion packages" on public.promotion_packages;
create policy "users read active promotion packages"
  on public.promotion_packages for select to authenticated using (active = true);

create table if not exists public.promotion_orders (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('listing', 'profile')),
  listing_id uuid references public.listings(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  package_id uuid not null references public.promotion_packages(id),
  transaction_id uuid unique references public.payment_transactions(id) on delete set null,
  status text not null check (status in ('pending_payment', 'payment_confirmed', 'active', 'expired', 'cancelled', 'failed', 'refunded')),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((target_type = 'listing' and listing_id is not null and profile_id is null) or (target_type = 'profile' and profile_id is not null and listing_id is null)),
  check ((status = 'active' and starts_at is not null and ends_at is not null) or status <> 'active')
);
create index if not exists promotion_orders_creator_idx on public.promotion_orders(creator_id, created_at desc);
create index if not exists promotion_orders_active_idx on public.promotion_orders(status, starts_at, ends_at);
alter table public.promotion_orders enable row level security;
drop policy if exists "creators read own promotion orders" on public.promotion_orders;
create policy "creators read own promotion orders"
  on public.promotion_orders for select
  using (creator_id = auth.uid() or public.is_verification_admin());

-- -------------------------------------------------------------------------
-- Digital product and collaboration foundations (disabled until delivery and
-- payment services are configured).
-- -------------------------------------------------------------------------

create table if not exists public.digital_product_assets (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid unique not null references public.listings(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  delivery_method text not null check (delivery_method in ('private_file', 'manual')),
  storage_path text unique,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.digital_product_assets enable row level security;
drop policy if exists "owners read own digital product assets" on public.digital_product_assets;
create policy "owners read own digital product assets"
  on public.digital_product_assets for select
  using (owner_id = auth.uid() or public.is_verification_admin());

create table if not exists public.digital_product_orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete restrict,
  transaction_id uuid unique references public.payment_transactions(id) on delete set null,
  status text not null check (status in ('pending_payment', 'paid', 'delivered', 'refunded', 'cancelled', 'failed')),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.digital_product_orders enable row level security;
drop policy if exists "participants read digital product orders" on public.digital_product_orders;
create policy "participants read digital product orders"
  on public.digital_product_orders for select
  using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_verification_admin());

create table if not exists public.collaboration_campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 160),
  brief text not null check (char_length(brief) between 10 and 5000),
  deliverables text not null check (char_length(deliverables) between 3 and 2000),
  budget_cents bigint not null check (budget_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  deadline date,
  status text not null default 'draft' check (status in ('draft', 'published', 'paused', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.collaboration_campaigns enable row level security;
drop policy if exists "users read discoverable campaigns" on public.collaboration_campaigns;
create policy "users read discoverable campaigns"
  on public.collaboration_campaigns for select
  using (status = 'published' or business_id = auth.uid() or public.is_verification_admin());

create table if not exists public.collaboration_offers (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.collaboration_campaigns(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  proposed_fee_cents bigint not null check (proposed_fee_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  deliverables text not null check (char_length(deliverables) between 3 and 2000),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, creator_id)
);
alter table public.collaboration_offers enable row level security;
drop policy if exists "participants read collaboration offers" on public.collaboration_offers;
create policy "participants read collaboration offers"
  on public.collaboration_offers for select
  using (
    creator_id = auth.uid()
    or exists (select 1 from public.collaboration_campaigns c where c.id = campaign_id and c.business_id = auth.uid())
    or public.is_verification_admin()
  );

-- Private digital files have no public read policy. A future server-side
-- delivery service must issue short-lived signed URLs only after payment.
insert into storage.buckets (id, name, public)
values ('digital-products', 'digital-products', false)
on conflict (id) do update set public = false;

-- -------------------------------------------------------------------------
-- Administrator financial reporting. It reads only confirmed database rows;
-- no estimates, impressions, clicks, sales, or simulated revenue are added.
-- -------------------------------------------------------------------------

create or replace function public.admin_monetization_summary(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_verification_admin() then
    raise exception 'Verification administrator access required.';
  end if;
  select jsonb_build_object(
    'confirmedPromotionRevenueCents', coalesce(sum(case when transaction_kind = 'promotion' and status = 'succeeded' then amount_cents else 0 end), 0),
    'confirmedSubscriptionRevenueCents', coalesce(sum(case when transaction_kind = 'subscription' and status = 'succeeded' then amount_cents else 0 end), 0),
    'confirmedMarketplaceRevenueCents', coalesce(sum(case when transaction_kind in ('digital_product', 'collaboration') and status = 'succeeded' then amount_cents else 0 end), 0),
    'confirmedGrossCents', coalesce(sum(case when status = 'succeeded' then amount_cents else 0 end), 0),
    'confirmedPlatformFeesCents', coalesce(sum(case when status = 'succeeded' then platform_fee_cents else 0 end), 0),
    'refundedCents', coalesce(sum(case when status = 'refunded' then amount_cents else 0 end), 0),
    'successfulTransactionCount', count(*) filter (where status = 'succeeded'),
    'failedPaymentCount', count(*) filter (where status = 'failed'),
    'pendingPayoutsCents', coalesce((select sum(amount_cents) from public.creator_payouts where status in ('pending', 'processing')), 0),
    'byCurrency', coalesce((
      select jsonb_agg(jsonb_build_object(
        'currency', grouped.currency,
        'grossCents', grouped.gross_cents,
        'platformFeesCents', grouped.platform_fees_cents,
        'refundedCents', grouped.refunded_cents,
        'promotionCents', grouped.promotion_cents,
        'subscriptionCents', grouped.subscription_cents,
        'marketplaceCents', grouped.marketplace_cents
      ) order by grouped.currency)
      from (
        select currency,
          coalesce(sum(case when status = 'succeeded' then amount_cents else 0 end), 0) as gross_cents,
          coalesce(sum(case when status = 'succeeded' then platform_fee_cents else 0 end), 0) as platform_fees_cents,
          coalesce(sum(case when status = 'refunded' then amount_cents else 0 end), 0) as refunded_cents,
          coalesce(sum(case when transaction_kind = 'promotion' and status = 'succeeded' then amount_cents else 0 end), 0) as promotion_cents,
          coalesce(sum(case when transaction_kind = 'subscription' and status = 'succeeded' then amount_cents else 0 end), 0) as subscription_cents,
          coalesce(sum(case when transaction_kind in ('digital_product', 'collaboration') and status = 'succeeded' then amount_cents else 0 end), 0) as marketplace_cents
        from public.payment_transactions
        where (p_from is null or created_at >= p_from)
          and (p_to is null or created_at < p_to)
        group by currency
      ) grouped
    ), '[]'::jsonb)
  ) into result
  from public.payment_transactions
  where (p_from is null or created_at >= p_from)
    and (p_to is null or created_at < p_to);
  return result;
end;
$$;
revoke all on function public.admin_monetization_summary(timestamptz, timestamptz) from public;
grant execute on function public.admin_monetization_summary(timestamptz, timestamptz) to authenticated;

-- Server-side entitlement check. Clients cannot edit subscription status or
-- plan entitlements, and creators may only ask about their own account.
create or replace function public.has_creator_entitlement(
  p_creator_id uuid,
  p_entitlement text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare allowed boolean;
begin
  if auth.uid() is distinct from p_creator_id and not public.is_verification_admin() then
    raise exception 'You may only check your own monetization entitlements.';
  end if;
  select exists (
    select 1
    from public.creator_subscriptions s
    join public.monetization_plans p on p.code = s.plan_code
    where s.creator_id = p_creator_id
      and s.status = 'active'
      and coalesce((p.entitlements ->> p_entitlement)::boolean, false) = true
  ) or exists (
    select 1
    from public.monetization_plans p
    where p.code = 'free'
      and p.active = true
      and coalesce((p.entitlements ->> p_entitlement)::boolean, false) = true
  ) into allowed;
  return allowed;
end;
$$;
revoke all on function public.has_creator_entitlement(uuid, text) from public;
grant execute on function public.has_creator_entitlement(uuid, text) to authenticated;

-- Trusted server/cron hook for expiring paid promotions. No browser role can
-- execute this function; payment confirmation and activation remain disabled
-- until a verified provider webhook service is added.
create or replace function public.expire_due_promotion_orders()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare changed_count bigint;
begin
  update public.promotion_orders
  set status = 'expired', updated_at = now()
  where status = 'active'
    and ends_at is not null
    and ends_at <= now();
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;
revoke all on function public.expire_due_promotion_orders() from public, anon, authenticated;

notify pgrst, 'reload schema';
