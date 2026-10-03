-- Phase 2 Supabase schema: listings + validation votes (RLS enforced)
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null check (char_length(handle) between 2 and 30),
  created_at timestamptz not null default now()
);

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 80),
  blurb text not null check (char_length(blurb) <= 280),
  category text not null check (category in ('digital-goods','services','content','saas','physical')),
  price_cents integer not null default 0 check (price_cents >= 0),
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

alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.votes enable row level security;

create policy "profiles readable" on public.profiles for select using (true);
create policy "own profile upsert" on public.profiles for insert with check (id = auth.uid());
create policy "own profile update" on public.profiles for update using (id = auth.uid());

create policy "active listings public" on public.listings for select using (status = 'active');
create policy "owner manages listings" on public.listings for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "votes readable" on public.votes for select using (true);
create policy "own vote write" on public.votes for insert with check (user_id = auth.uid());
create policy "own vote remove" on public.votes for delete using (user_id = auth.uid());
-- Phase 3: creator contact handles for instant WhatsApp/Telegram chat + feed categories
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists contact_channel text check (contact_channel in ('whatsapp','telegram'));
alter table public.profiles add column if not exists contact_handle text;

alter table public.listings drop constraint if exists listings_category_check;
alter table public.listings add constraint listings_category_check check (category in ('services','tech','campus','digital'));

-- Phase 4: listings cover images, concept validation ideas + bizz/fizz votes
alter table public.listings add column if not exists image_url text;

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

alter table public.ideas enable row level security;
alter table public.idea_votes enable row level security;

create policy "open ideas readable" on public.ideas for select using (status = 'open' or owner_id = auth.uid());
create policy "owner manages ideas" on public.ideas for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "idea votes readable" on public.idea_votes for select using (true);
create policy "own idea vote insert" on public.idea_votes for insert with check (user_id = auth.uid());
create policy "own idea vote update" on public.idea_votes for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own idea vote delete" on public.idea_votes for delete using (user_id = auth.uid());

-- Storage bucket for listing cover images (public read, authenticated owner write)
insert into storage.buckets (id, name, public) values ('listing-images', 'listing-images', true)
  on conflict (id) do nothing;

create policy "listing images public read" on storage.objects for select using (bucket_id = 'listing-images');
create policy "owners upload listing images" on storage.objects for insert with check (
  bucket_id = 'listing-images' and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "owners manage own listing images" on storage.objects for all using (
  bucket_id = 'listing-images' and (storage.foldername(name))[1] = auth.uid()::text
);

-- Realtime for live tally bars (idempotent: only add if not already in the publication)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'idea_votes'
  ) then
    execute 'alter publication supabase_realtime add table public.idea_votes';
  end if;
end$$;
