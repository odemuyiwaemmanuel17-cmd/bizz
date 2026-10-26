-- HustleHub first verification administrator bootstrap.
--
-- BEFORE RUNNING:
-- 1. In Supabase Dashboard, open Authentication -> Users.
-- 2. Copy the exact User UID for your existing HustleHub account.
-- 3. Replace ONLY the value below with that UUID.
-- 4. Paste this complete file into a NEW Supabase SQL Editor query.
--
-- This version intentionally uses plain SQL only. It does not use DO blocks,
-- dollar-quoted strings, browser email values, profile metadata, or a service
-- role key. It is safe to run again for the same account.

begin;

-- Core authorization objects are repeated here so this bootstrap can be run
-- safely even when the full admin migration has not yet been applied. The
-- full creator-verification-admin-migration.sql is still required for the
-- verification queue, review functions, audit trail, and private evidence.
create table if not exists public.verification_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.verification_admins enable row level security;

create or replace function public.is_verification_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as 'select exists (select 1 from public.verification_admins where user_id = auth.uid() and revoked_at is null)';
revoke all on function public.is_verification_admin() from public;
grant execute on function public.is_verification_admin() to authenticated;

-- Replace the value between the quotes with your exact Auth User UID.
drop table if exists pg_temp.hustlehub_bootstrap_target;
create temporary table hustlehub_bootstrap_target (
  user_id uuid not null
);

insert into hustlehub_bootstrap_target (user_id)
values ('REPLACE_WITH_EXACT_SUPABASE_AUTH_USER_UUID'::uuid);

-- This inserts only when the Auth user and profile exist and no different
-- active administrator is already present. The final query explains a no-op.
insert into public.verification_admins (user_id, granted_by, revoked_at)
select target.user_id, null, null
from hustlehub_bootstrap_target target
where exists (
  select 1
  from auth.users auth_user
  where auth_user.id = target.user_id
)
and exists (
  select 1
  from public.profiles profile_row
  where profile_row.id = target.user_id
)
and not exists (
  select 1
  from public.verification_admins existing_admin
  where existing_admin.revoked_at is null
    and existing_admin.user_id <> target.user_id
)
on conflict (user_id) do update
set revoked_at = null;

commit;

-- This result never exposes credentials. It should show three true values.
select
  target.user_id,
  exists (
    select 1
    from auth.users auth_user
    where auth_user.id = target.user_id
  ) as auth_user_exists,
  exists (
    select 1
    from public.profiles profile_row
    where profile_row.id = target.user_id
  ) as profile_exists,
  exists (
    select 1
    from public.verification_admins admin_row
    where admin_row.user_id = target.user_id
      and admin_row.revoked_at is null
  ) as active_admin_grant
from hustlehub_bootstrap_target target;
