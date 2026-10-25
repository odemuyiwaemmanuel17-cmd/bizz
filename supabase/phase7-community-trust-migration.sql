-- Phase 7: creator follows, editable comments, comment reports, and
-- verification requests. Run after the Phase 4 social migration.
create extension if not exists pgcrypto;

-- Existing Phase 4 comments need an edit timestamp and an ownership update
-- policy. The check constraint remains the database-level length guard.
alter table public.video_comments add column if not exists updated_at timestamptz not null default now();
update public.video_comments set updated_at = created_at where updated_at is null;
create index if not exists video_comments_author_idx on public.video_comments(user_id, created_at desc);

drop policy if exists "users create comments" on public.video_comments;
create policy "users create comments" on public.video_comments for insert with check (
  user_id = auth.uid()
  and exists (select 1 from public.creator_videos v where v.id = video_id and v.status = 'published')
);

drop policy if exists "users update own comments" on public.video_comments;
create policy "users update own comments" on public.video_comments
  for update using (user_id = auth.uid() and exists (select 1 from public.creator_videos v where v.id = video_id and v.status = 'published'))
  with check (user_id = auth.uid() and exists (select 1 from public.creator_videos v where v.id = video_id and v.status = 'published'));

create or replace function public.touch_video_comment_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists video_comment_updated_at on public.video_comments;
create trigger video_comment_updated_at before update on public.video_comments
for each row execute function public.touch_video_comment_updated_at();

create table if not exists public.video_comment_reports (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.video_comments(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  unique (comment_id, reporter_id)
);
create index if not exists video_comment_reports_status_idx on public.video_comment_reports(status, created_at desc);
alter table public.video_comment_reports enable row level security;
drop policy if exists "users create comment reports" on public.video_comment_reports;
create policy "users create comment reports" on public.video_comment_reports
  for insert with check (reporter_id = auth.uid());
drop policy if exists "users read own comment reports" on public.video_comment_reports;
create policy "users read own comment reports" on public.video_comment_reports
  for select using (reporter_id = auth.uid());

create table if not exists public.creator_verification_requests (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  evidence text not null check (char_length(evidence) between 10 and 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewer_id uuid references public.profiles(id) on delete set null,
  reviewer_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (creator_id, status)
);
create index if not exists creator_verification_requests_creator_idx on public.creator_verification_requests(creator_id, created_at desc);
alter table public.creator_verification_requests enable row level security;
drop policy if exists "creators submit verification requests" on public.creator_verification_requests;
create policy "creators submit verification requests" on public.creator_verification_requests
  for insert with check (creator_id = auth.uid() and status = 'pending' and reviewer_id is null);
drop policy if exists "creators read own verification requests" on public.creator_verification_requests;
create policy "creators read own verification requests" on public.creator_verification_requests
  for select using (creator_id = auth.uid());

-- There is no reviewer/admin identity model in this application yet. Until
-- one exists, normal clients cannot approve requests or set is_verified.
create or replace function public.prevent_self_verification()
returns trigger language plpgsql as $$
begin
  if auth.role() <> 'service_role' and new.is_verified is distinct from old.is_verified then
    raise exception 'Only an authorized reviewer may change verification status';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_profile_verification on public.profiles;
create trigger protect_profile_verification before update on public.profiles
for each row execute function public.prevent_self_verification();

notify pgrst, 'reload schema';
