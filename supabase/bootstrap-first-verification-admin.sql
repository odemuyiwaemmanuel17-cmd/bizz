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
