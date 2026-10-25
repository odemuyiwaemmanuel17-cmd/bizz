-- HustleHub creator verification administration.
-- Run after phase7-community-trust-migration.sql and schema-patch.sql.
--
-- This migration deliberately does not add a client-editable role column or a
-- service-role key to the browser. The first administrator must be granted by
-- the project owner in the Supabase SQL Editor (see the bootstrap comment near
-- the verification_admins table below).

create extension if not exists pgcrypto;

-- -------------------------------------------------------------------------
-- Verification application data
-- -------------------------------------------------------------------------

alter table public.creator_verification_requests
  add column if not exists verification_category text not null default 'other',
  add column if not exists request_reason text not null default '',
  add column if not exists details jsonb not null default '{}'::jsonb;

alter table public.creator_verification_requests
  drop constraint if exists creator_verification_requests_status_check;
alter table public.creator_verification_requests
  add constraint creator_verification_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'more_info_required'));

alter table public.creator_verification_requests
  drop constraint if exists creator_verification_requests_category_check;
alter table public.creator_verification_requests
  add constraint creator_verification_requests_category_check
  check (verification_category in ('identity', 'business', 'professional', 'creator', 'other'));

create index if not exists creator_verification_requests_status_idx
  on public.creator_verification_requests(status, created_at desc);

create unique index if not exists creator_verification_requests_open_creator_idx
  on public.creator_verification_requests(creator_id)
  where status in ('pending', 'more_info_required');

-- Uploaded evidence is metadata only; the actual bytes live in the private
-- verification-evidence storage bucket below.
create table if not exists public.creator_verification_evidence (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.creator_verification_requests(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null check (char_length(mime_type) between 1 and 160),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default now()
);
create index if not exists creator_verification_evidence_request_idx
  on public.creator_verification_evidence(request_id, created_at);
alter table public.creator_verification_evidence enable row level security;

-- -------------------------------------------------------------------------
-- Explicit administrator authorization
-- -------------------------------------------------------------------------

create table if not exists public.verification_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.verification_admins enable row level security;

-- Bootstrap procedure for the project owner:
--   1. Find the target auth user's UUID in Authentication → Users.
--   2. Run this once in Supabase SQL Editor as the project owner/postgres role:
--
--      insert into public.verification_admins (user_id)
--      values ('AUTH-USER-UUID')
--      on conflict (user_id) do update set revoked_at = null;
--
-- There is intentionally no public insert/update policy on this table. A
-- browser user cannot grant themselves administrator access.

create or replace function public.is_verification_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.verification_admins
    where user_id = auth.uid()
      and revoked_at is null
  );
$$;
revoke all on function public.is_verification_admin() from public;
grant execute on function public.is_verification_admin() to authenticated;

-- -------------------------------------------------------------------------
-- Request and audit RLS
-- -------------------------------------------------------------------------

drop policy if exists "creators submit verification requests" on public.creator_verification_requests;
drop policy if exists "creators read own verification requests" on public.creator_verification_requests;
drop policy if exists "verification admins read requests" on public.creator_verification_requests;

-- Inserts and status changes go through SECURITY DEFINER functions below so
-- invalid transitions and forged reviewer fields cannot be written by clients.
create policy "creators read own verification requests"
  on public.creator_verification_requests for select
  using (creator_id = auth.uid() or public.is_verification_admin());

create policy "verification admins read requests"
  on public.creator_verification_requests for select
  using (public.is_verification_admin());

drop policy if exists "creators manage own verification evidence" on public.creator_verification_evidence;
drop policy if exists "verification admins read evidence" on public.creator_verification_evidence;
create policy "creators manage own verification evidence"
  on public.creator_verification_evidence for all
  using (creator_id = auth.uid())
  with check (
    creator_id = auth.uid()
    and exists (
      select 1
      from public.creator_verification_requests r
      where r.id = request_id
        and r.creator_id = auth.uid()
        and r.status in ('pending', 'more_info_required')
    )
  );
create policy "verification admins read evidence"
  on public.creator_verification_evidence for select
  using (public.is_verification_admin());

create table if not exists public.creator_verification_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.creator_verification_requests(id) on delete cascade,
  administrator_id uuid not null references public.profiles(id) on delete restrict,
  previous_status text not null,
  new_status text not null,
  decision_note text,
  created_at timestamptz not null default now()
);
create index if not exists creator_verification_audit_request_idx
  on public.creator_verification_audit(request_id, created_at desc);
alter table public.creator_verification_audit enable row level security;
drop policy if exists "verification admins read audit" on public.creator_verification_audit;
create policy "verification admins read audit"
  on public.creator_verification_audit for select
  using (public.is_verification_admin());

-- Only the authorized review function may change the visible badge.
create or replace function public.prevent_self_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_verified is distinct from old.is_verified
     and not public.is_verification_admin() then
    raise exception 'Only an authorized verification administrator may change verification status';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_profile_verification on public.profiles;
create trigger protect_profile_verification
  before update on public.profiles
  for each row execute function public.prevent_self_verification();

-- -------------------------------------------------------------------------
-- Creator functions
-- -------------------------------------------------------------------------

create or replace function public.submit_creator_verification(
  p_verification_category text,
  p_request_reason text,
  p_evidence text,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  existing_id uuid;
  existing_status text;
  result_id uuid;
begin
  if actor is null then raise exception 'You must be signed in.'; end if;
  if public.is_verification_admin() then
    -- Administrators can still be creators, so this is not a prohibition.
    null;
  end if;
  if p_verification_category not in ('identity', 'business', 'professional', 'creator', 'other') then
    raise exception 'Choose a valid verification category.';
  end if;
  if char_length(trim(coalesce(p_request_reason, ''))) not between 10 and 2000 then
    raise exception 'The verification reason must be between 10 and 2,000 characters.';
  end if;
  if char_length(trim(coalesce(p_evidence, ''))) not between 10 and 2000 then
    raise exception 'Evidence must be between 10 and 2,000 characters.';
  end if;
  if exists (select 1 from public.profiles where id = actor and is_verified = true) then
    raise exception 'This creator is already verified.';
  end if;

  select id, status into existing_id, existing_status
  from public.creator_verification_requests
  where creator_id = actor
    and status in ('pending', 'more_info_required')
  order by created_at desc
  limit 1
  for update;

  if existing_id is not null and existing_status = 'pending' then
    raise exception 'A verification application is already pending.';
  end if;

  if existing_id is not null then
    update public.creator_verification_requests
    set verification_category = p_verification_category,
        request_reason = trim(p_request_reason),
        evidence = trim(p_evidence),
        details = coalesce(p_details, '{}'::jsonb),
        status = 'pending',
        reviewer_id = null,
        reviewer_note = null,
        reviewed_at = null
    where id = existing_id
    returning id into result_id;
  else
    insert into public.creator_verification_requests
      (creator_id, verification_category, request_reason, evidence, details, status)
    values
      (actor, p_verification_category, trim(p_request_reason), trim(p_evidence), coalesce(p_details, '{}'::jsonb), 'pending')
    returning id into result_id;
  end if;
  return result_id;
end;
$$;
revoke all on function public.submit_creator_verification(text, text, text, jsonb) from public;
grant execute on function public.submit_creator_verification(text, text, text, jsonb) to authenticated;

-- -------------------------------------------------------------------------
-- Administrator read and review functions
-- -------------------------------------------------------------------------

create or replace function public.admin_list_creator_verification_requests(
  p_status text default null,
  p_search text default null
)
returns table (
  id uuid,
  creator_id uuid,
  creator_name text,
  creator_username text,
  avatar_url text,
  verification_category text,
  request_reason text,
  status text,
  created_at timestamptz,
  reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_verification_admin() then
    raise exception 'Verification administrator access required.';
  end if;
  return query
  select r.id,
         r.creator_id,
         coalesce(p.display_name, p.username, 'Unnamed creator'),
         p.username,
         p.avatar_url,
         r.verification_category,
         r.request_reason,
         r.status,
         r.created_at,
         r.reviewed_at
  from public.creator_verification_requests r
  join public.profiles p on p.id = r.creator_id
  where (p_status is null or p_status = 'all' or r.status = p_status)
    and (
      nullif(trim(coalesce(p_search, '')), '') is null
      or lower(coalesce(p.display_name, '')) like '%' || lower(trim(p_search)) || '%'
      or lower(coalesce(p.username, '')) like '%' || lower(trim(p_search)) || '%'
      or r.id::text = trim(p_search)
    )
  order by r.created_at desc;
end;
$$;
revoke all on function public.admin_list_creator_verification_requests(text, text) from public;
grant execute on function public.admin_list_creator_verification_requests(text, text) to authenticated;

create or replace function public.admin_pending_creator_verification_count()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare result bigint;
begin
  if not public.is_verification_admin() then
    raise exception 'Verification administrator access required.';
  end if;
  select count(*) into result
  from public.creator_verification_requests
  where status = 'pending';
  return result;
end;
$$;
revoke all on function public.admin_pending_creator_verification_count() from public;
grant execute on function public.admin_pending_creator_verification_count() to authenticated;

create or replace function public.admin_review_creator_verification(
  p_request_id uuid,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  request_row public.creator_verification_requests%rowtype;
  next_status text;
  note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_verification_admin() then
    raise exception 'Verification administrator access required.';
  end if;
  if p_action not in ('approve', 'reject', 'request_more_information') then
    raise exception 'Unsupported verification review action.';
  end if;
  if p_action in ('reject', 'request_more_information') and char_length(coalesce(note, '')) < 3 then
    raise exception 'A reason or request message is required.';
  end if;
  if char_length(coalesce(note, '')) > 2000 then
    raise exception 'Review notes must be 2,000 characters or fewer.';
  end if;

  select * into request_row
  from public.creator_verification_requests
  where id = p_request_id
  for update;
  if not found then raise exception 'Verification application not found.'; end if;
  if request_row.status not in ('pending', 'more_info_required') then
    raise exception 'This application has already been finalized.';
  end if;

  next_status := case p_action
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    else 'more_info_required'
  end;

  update public.creator_verification_requests
  set status = next_status,
      reviewer_id = actor,
      reviewer_note = note,
      reviewed_at = now()
  where id = p_request_id;

  update public.profiles
  set is_verified = (next_status = 'approved')
  where id = request_row.creator_id;

  insert into public.creator_verification_audit
    (request_id, administrator_id, previous_status, new_status, decision_note)
  values
    (p_request_id, actor, request_row.status, next_status, note);

  return jsonb_build_object('id', p_request_id, 'status', next_status);
end;
$$;
revoke all on function public.admin_review_creator_verification(uuid, text, text) from public;
grant execute on function public.admin_review_creator_verification(uuid, text, text) to authenticated;

-- -------------------------------------------------------------------------
-- Private evidence storage
-- -------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'verification-evidence',
  'verification-evidence',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']::text[]
)
on conflict (id) do update set public = false, file_size_limit = 10485760;

drop policy if exists "verification creators upload evidence" on storage.objects;
create policy "verification creators upload evidence"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'verification-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
    and exists (
      select 1
      from public.creator_verification_requests r
      where r.id = ((storage.foldername(name))[2])::uuid
        and r.creator_id = auth.uid()
        and r.status in ('pending', 'more_info_required')
    )
  );

drop policy if exists "verification evidence authorized read" on storage.objects;
create policy "verification evidence authorized read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'verification-evidence'
    and (
      public.is_verification_admin()
      or (storage.foldername(name))[1] = auth.uid()::text
    )
  );

drop policy if exists "verification creators delete own evidence" on storage.objects;
create policy "verification creators delete own evidence"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'verification-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

notify pgrst, 'reload schema';
