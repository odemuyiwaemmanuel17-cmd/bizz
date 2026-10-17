-- Run this complete file in Supabase SQL Editor.
-- It repairs an existing creator_videos table as well as creating it when absent.

create extension if not exists pgcrypto;

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists campus text;
alter table public.profiles add column if not exists state text;
alter table public.profiles add column if not exists country text;
alter table public.profiles add column if not exists creator_type text;
alter table public.profiles add column if not exists is_verified boolean not null default false;
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username)) where username is not null;

create table if not exists public.creator_videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  storage_path text,
  video_url text,
  caption text,
  status text not null default 'published' check (status in ('uploading', 'failed', 'published', 'private')),
  created_at timestamptz not null default now()
);

-- Repair tables created by an older migration that lacks one or more columns.
alter table public.creator_videos add column if not exists user_id uuid references public.profiles(id) on delete cascade;
alter table public.creator_videos add column if not exists storage_path text;
alter table public.creator_videos add column if not exists video_url text;
alter table public.creator_videos add column if not exists caption text;
alter table public.creator_videos add column if not exists status text not null default 'published';
alter table public.creator_videos add column if not exists created_at timestamptz not null default now();
update public.creator_videos set status = 'published' where status is null;
alter table public.creator_videos drop constraint if exists creator_videos_status_check;
alter table public.creator_videos add constraint creator_videos_status_check check (status in ('uploading', 'failed', 'published', 'private'));

alter table public.creator_videos enable row level security;
drop policy if exists "creator videos readable" on public.creator_videos;
create policy "creator videos readable" on public.creator_videos
  for select using (status = 'published' or user_id = auth.uid());
drop policy if exists "creator owns videos" on public.creator_videos;
create policy "creator owns videos" on public.creator_videos
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('creator-videos', 'creator-videos', true)
on conflict (id) do update set public = true;

drop policy if exists "creator videos public read" on storage.objects;
create policy "creator videos public read" on storage.objects
  for select using (bucket_id = 'creator-videos');
drop policy if exists "creator uploads videos" on storage.objects;
create policy "creator uploads videos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'creator-videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "creator manages videos" on storage.objects;
create policy "creator manages videos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'creator-videos' and (storage.foldername(name))[1] = auth.uid()::text);

notify pgrst, 'reload schema';
