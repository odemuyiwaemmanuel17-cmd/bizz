-- Phase 8: marketplace search indexes, listing reports, and non-paid
-- promotion requests. No payment, subscription, ranking, or activation is
-- created by this migration.
create extension if not exists pgcrypto;

create index if not exists listings_active_category_price_idx
  on public.listings(category, price_cents, created_at desc)
  where status = 'active';
create index if not exists listings_active_owner_idx
  on public.listings(user_id, created_at desc)
  where status = 'active';
create index if not exists creator_videos_published_created_idx
  on public.creator_videos(created_at desc, user_id)
  where status = 'published';
create index if not exists profiles_public_area_idx
  on public.profiles(campus, state, country);
create index if not exists profiles_public_name_idx
  on public.profiles(lower(username), lower(display_name));

create table if not exists public.listing_reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  unique (listing_id, reporter_id)
);
create index if not exists listing_reports_status_idx on public.listing_reports(status, created_at desc);
alter table public.listing_reports enable row level security;
drop policy if exists "users create listing reports" on public.listing_reports;
create policy "users create listing reports" on public.listing_reports
  for insert with check (reporter_id = auth.uid());
drop policy if exists "users read own listing reports" on public.listing_reports;
create policy "users read own listing reports" on public.listing_reports
  for select using (reporter_id = auth.uid());

create table if not exists public.promotion_requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  note text not null check (char_length(note) between 10 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (listing_id, status)
);
create index if not exists promotion_requests_creator_idx on public.promotion_requests(creator_id, created_at desc);
alter table public.promotion_requests enable row level security;
drop policy if exists "creators submit promotion requests" on public.promotion_requests;
create policy "creators submit promotion requests" on public.promotion_requests
  for insert with check (
    creator_id = auth.uid()
    and status = 'pending'
    and exists (select 1 from public.listings l where l.id = listing_id and l.user_id = auth.uid() and l.status = 'active')
  );
drop policy if exists "creators read own promotion requests" on public.promotion_requests;
create policy "creators read own promotion requests" on public.promotion_requests
  for select using (creator_id = auth.uid());

notify pgrst, 'reload schema';
