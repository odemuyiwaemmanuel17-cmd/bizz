-- =====================================================================
-- Patch: align public.listings with the Post-a-Bizz publish payload.
-- Idempotent — safe to run multiple times in the Supabase SQL Editor.
-- =====================================================================

-- 1) Ensure a creator column exists under BOTH names so inserts that set
--    user_id (and any legacy code setting owner_id) satisfy RLS.
alter table public.listings add column if not exists owner_id uuid references public.profiles(id) on delete cascade;
alter table public.listings add column if not exists user_id uuid;

-- Backfill whichever column was empty from the other.
update public.listings set user_id = owner_id where user_id is null and owner_id is not null;
update public.listings set owner_id = user_id where owner_id is null and user_id is not null;

-- If neither existed, rows created via auth get their owner from the JWT at
-- insert time going forward; historic orphan rows are left untouched.

-- 2) Pitch/description columns: keep both names available.
alter table public.listings add column if not exists description text;
update public.listings set description = blurb where description is null and blurb is not null;

-- 3) Price + contact + image columns used by the app.
alter table public.listings add column if not exists price_cents integer not null default 0 check (price_cents >= 0);
alter table public.listings add column if not exists price numeric;
update public.listings set price = price_cents / 100.0 where price is null;
alter table public.listings add column if not exists contact_link text;
alter table public.listings add column if not exists image_url text;
alter table public.listings add column if not exists status text not null default 'active';

-- 4) Enforce RLS with permissive policies covering both owner columns.
alter table public.listings enable row level security;

drop policy if exists "active listings public" on public.listings;
create policy "active listings public" on public.listings for select using (status = 'active');

drop policy if exists "owner manages listings" on public.listings;
create policy "owner manages listings" on public.listings for all
  using (owner_id = auth.uid() or user_id = auth.uid())
  with check (owner_id = auth.uid() or user_id = auth.uid());

-- Insert-only policy so a payload that sets user_id = auth.uid() always passes.
drop policy if exists "anyone can post a bizz" on public.listings;
create policy "anyone can post a bizz" on public.listings for insert to authenticated
  with check (user_id = auth.uid() or owner_id = auth.uid());

-- 5) Refresh the schema cache immediately (also auto-refreshes within ~seconds).
notify pgrst, 'reload schema';

-- =====================================================================
-- Creator control center: public usernames and creator videos.
-- Run this block in the Supabase SQL editor before using profile/video
-- publishing. The frontend intentionally reports a clear error until it
-- has been applied; it never fabricates a successful upload.
-- =====================================================================
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists campus text;
alter table public.profiles add column if not exists state text;
alter table public.profiles add column if not exists country text;
alter table public.profiles add column if not exists creator_type text;
alter table public.profiles add column if not exists is_verified boolean not null default false;
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username)) where username is not null;

create table if not exists public.creator_videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  video_url text not null,
  caption text,
  created_at timestamptz not null default now()
);
-- The table may already exist from an earlier creator-video migration. Keep
-- the columns used by the web client present in that case as well.
alter table public.creator_videos add column if not exists user_id uuid references public.profiles(id) on delete cascade;
alter table public.creator_videos add column if not exists storage_path text;
alter table public.creator_videos add column if not exists video_url text;
alter table public.creator_videos add column if not exists caption text;
alter table public.creator_videos add column if not exists created_at timestamptz not null default now();
alter table public.creator_videos enable row level security;
drop policy if exists "creator videos readable" on public.creator_videos;
create policy "creator videos readable" on public.creator_videos for select using (true);
drop policy if exists "creator owns videos" on public.creator_videos;
create policy "creator owns videos" on public.creator_videos for all using (user_id = auth.uid()) with check (user_id = auth.uid());

insert into storage.buckets (id, name, public) values ('creator-videos', 'creator-videos', true) on conflict (id) do nothing;
drop policy if exists "creator videos public read" on storage.objects;
create policy "creator videos public read" on storage.objects for select using (bucket_id = 'creator-videos');
drop policy if exists "creator uploads videos" on storage.objects;
create policy "creator uploads videos" on storage.objects for insert to authenticated with check (bucket_id = 'creator-videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "creator manages videos" on storage.objects;
create policy "creator manages videos" on storage.objects for delete to authenticated using (bucket_id = 'creator-videos' and (storage.foldername(name))[1] = auth.uid()::text);

notify pgrst, 'reload schema';

-- =====================================================================
-- Publish fix: listings.contact_link must never be NULL.
-- The Post-a-Bizz wizard now always sends a normalised WhatsApp/Telegram
-- deep link (or "" when the creator leaves it blank), but existing rows
-- may still hold NULLs, which breaks NOT NULL rewrites and joins.
-- Backfill them with the empty-string placeholder and add a DEFAULT so
-- any legacy insert path that omits the column can never fail again.
-- =====================================================================

alter table public.listings add column if not exists contact_link text;
update public.listings set contact_link = '' where contact_link is null;
alter table public.listings alter column contact_link set default '';
alter table public.listings alter column contact_link set not null;

notify pgrst, 'reload schema';
