-- HustleHub Phase 4 social interactions. Run the complete file in Supabase SQL Editor.
create table if not exists public.video_likes (
  id uuid primary key default gen_random_uuid(), video_id uuid not null references public.creator_videos(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, created_at timestamptz not null default now(),
  unique (video_id, user_id)
);
create index if not exists video_likes_video_idx on public.video_likes(video_id);

create table if not exists public.video_comments (
  id uuid primary key default gen_random_uuid(), video_id uuid not null references public.creator_videos(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists video_comments_video_idx on public.video_comments(video_id, created_at desc);

create table if not exists public.creator_follows (
  id uuid primary key default gen_random_uuid(), creator_id uuid not null references public.profiles(id) on delete cascade,
  follower_id uuid not null references public.profiles(id) on delete cascade, created_at timestamptz not null default now(),
  unique (creator_id, follower_id), check (creator_id <> follower_id)
);
create index if not exists creator_follows_creator_idx on public.creator_follows(creator_id);
create index if not exists creator_follows_follower_idx on public.creator_follows(follower_id);

create table if not exists public.saved_videos (
  id uuid primary key default gen_random_uuid(), video_id uuid not null references public.creator_videos(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, created_at timestamptz not null default now(),
  unique (video_id, user_id)
);
create index if not exists saved_videos_user_idx on public.saved_videos(user_id, created_at desc);

alter table public.video_likes enable row level security;
alter table public.video_comments enable row level security;
alter table public.creator_follows enable row level security;
alter table public.saved_videos enable row level security;

drop policy if exists "video likes readable" on public.video_likes;
create policy "video likes readable" on public.video_likes for select using (true);
drop policy if exists "users manage own video likes" on public.video_likes;
create policy "users manage own video likes" on public.video_likes for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "published comments readable" on public.video_comments;
create policy "published comments readable" on public.video_comments for select using (exists (select 1 from public.creator_videos v where v.id = video_id and v.status = 'published'));
drop policy if exists "users create comments" on public.video_comments;
create policy "users create comments" on public.video_comments for insert with check (user_id = auth.uid());
drop policy if exists "users delete own comments" on public.video_comments;
create policy "users delete own comments" on public.video_comments for delete using (user_id = auth.uid());

drop policy if exists "follow relationships readable" on public.creator_follows;
create policy "follow relationships readable" on public.creator_follows for select using (true);
drop policy if exists "users manage own follows" on public.creator_follows;
create policy "users manage own follows" on public.creator_follows for all using (follower_id = auth.uid()) with check (follower_id = auth.uid() and creator_id <> auth.uid());

drop policy if exists "users read own saved videos" on public.saved_videos;
create policy "users read own saved videos" on public.saved_videos for select using (user_id = auth.uid());
drop policy if exists "users manage own saved videos" on public.saved_videos;
create policy "users manage own saved videos" on public.saved_videos for all using (user_id = auth.uid()) with check (user_id = auth.uid());

notify pgrst, 'reload schema';
