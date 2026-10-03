-- HustleHub Supabase schema (Phases 2-4) — idempotent, safe to run multiple times.
-- Run in Supabase Dashboard → SQL Editor.

create extension if not exists pgcrypto;

-- ========== Tables ==========

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null check (char_length(handle) between 2 and 30),
  display_name text,
  avatar_url text,
  contact_channel text check (contact_channel in ('whatsapp','telegram')),
  contact_handle text,
  created_at timestamptz not null default now()
);

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 80),
  blurb text not null check (char_length(blurb) <= 280),
  category text not null check (category in ('services','tech','campus','digital')),
  price_cents integer not null default 0 check (price_cents >= 0),
  image_url text,
  status text not null default 'active' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists listings_active_category_idx
  on public.listings (category, created_at desc) where status = 'active';

create table if not exists public.votes (
  listing_id uuid not null references public.listings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (listing_id, user_id)
);

create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 80),
  pitch text not null default '' check (char_length(pitch) <= 280),
  category text not null check (category in ('services','tech','campus','digital')),
  target_price_cents integer not null default 0 check (target_price_cents >= 0),
  image_url text,
  status text not null default 'open' check (status in ('open','validated','launched','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ideas_open_idx on public.ideas (created_at desc) where status = 'open';

create table if not exists public.idea_votes (
  idea_id uuid not null references public.ideas(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  choice text not null check (choice in ('bizz','fizz')),
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);
create index if not exists idea_votes_idea_idx on public.idea_votes (idea_id);

-- ========== Row Level Security ==========

alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.votes enable row level security;
alter table public.ideas enable row level security;
alter table public.idea_votes enable row level security;

drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select using (true);

drop policy if exists "own profile upsert" on public.profiles;
create policy "own profile upsert" on public.profiles for insert with check (id = auth.uid());

drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update using (id = auth.uid());

drop policy if exists "active listings public" on public.listings;
create policy "active listings public" on public.listings for select using (status = 'active');

drop policy if exists "owner manages listings" on public.listings;
create policy "owner manages listings" on public.listings for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "votes readable" on public.votes;
create policy "votes readable" on public.votes for select using (true);

drop policy if exists "own vote write" on public.votes;
create policy "own vote write" on public.votes for insert with check (user_id = auth.uid());

drop policy if exists "own vote remove" on public.votes;
create policy "own vote remove" on public.votes for delete using (user_id = auth.uid());

drop policy if exists "open ideas readable" on public.ideas;
create policy "open ideas readable" on public.ideas for select using (status = 'open' or owner_id = auth.uid());

drop policy if exists "owner manages ideas" on public.ideas;
create policy "owner manages ideas" on public.ideas for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "idea votes readable" on public.idea_votes;
create policy "idea votes readable" on public.idea_votes for select using (true);

drop policy if exists "own idea vote insert" on public.idea_votes;
create policy "own idea vote insert" on public.idea_votes for insert with check (user_id = auth.uid());

drop policy if exists "own idea vote update" on public.idea_votes;
create policy "own idea vote update" on public.idea_votes for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own idea vote delete" on public.idea_votes;
create policy "own idea vote delete" on public.idea_votes for delete using (user_id = auth.uid());

-- ========== Storage bucket for listing images ==========

insert into storage.buckets (id, name, public)
values ('listing-images', 'listing-images', true)
on conflict (id) do nothing;

drop policy if exists "listing images public read" on storage.objects;
create policy "listing images public read" on storage.objects for select using (bucket_id = 'listing-images');

drop policy if exists "owners upload listing images" on storage.objects;
create policy "owners upload listing images" on storage.objects for insert with check (
  bucket_id = 'listing-images'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "owners manage own listing images" on storage.objects;
create policy "owners manage own listing images" on storage.objects for all using (
  bucket_id = 'listing-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ========== Realtime for live tally bars ==========

do $blk$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'idea_votes'
  ) then
    execute 'alter publication supabase_realtime add table public.idea_votes';
  end if;
end
$blk$;

-- ========== Auto-create a profile for every new auth user ==========

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $fn$
begin
  insert into public.profiles (id, handle, display_name)
  values (
    new.id,
    left(lower(regexp_replace(
           coalesce(new.raw_user_meta_data->>'user_name',
                    split_part(coalesce(new.email,'user'),'@',1)),
           '[^a-z0-9_]', '', 'g')), 24)
      || '_' || substr(replace(new.id::text,'-',''), 1, 5),
    coalesce(new.raw_user_meta_data->>'full_name',
             split_part(coalesce(new.email,'New creator'),'@',1))
  )
  on conflict (id) do nothing;
  return new;
end
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for users who signed up before this migration existed
insert into public.profiles (id, handle, display_name)
select u.id,
       left(lower(regexp_replace(split_part(u.email,'@',1), '[^a-z0-9_]', '', 'g')), 24)
         || '_' || substr(replace(u.id::text,'-',''), 1, 5),
       split_part(u.email,'@',1)
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;
