-- HustleHub first verification administrator bootstrap.
--
-- SAFETY:
--   * Replace only the placeholder below with the exact UUID from
--     Supabase Dashboard -> Authentication -> Users -> User UID.
--   * Run this in the Supabase SQL Editor as the project owner/postgres role,
--     never from the browser and never with the anon key.
--   * The block aborts if another active verification administrator already
--     exists, so it cannot silently grant a second account administrator
--     access. Re-running it for the same account is safe and idempotent.

begin;

do $bootstrap$
declare
  target_text text := 'REPLACE_WITH_EXACT_SUPABASE_AUTH_USER_UUID';
  target_id uuid;
begin
  if target_text = 'REPLACE_WITH_EXACT_SUPABASE_AUTH_USER_UUID' then
    raise exception 'Replace target_text with the exact Supabase Auth user UUID before running this bootstrap.';
  end if;

  begin
    target_id := target_text::uuid;
  exception when invalid_text_representation then
    raise exception 'The configured administrator ID is not a valid UUID: %', target_text;
  end;

  if not exists (select 1 from auth.users where id = target_id) then
    raise exception 'No Supabase Auth user exists with ID %.', target_id;
  end if;

  if not exists (select 1 from public.profiles where id = target_id) then
    raise exception 'The Auth user has no public.profiles row. Sign in once to HustleHub, then run this bootstrap again.';
  end if;

  if exists (
    select 1
    from public.verification_admins
    where revoked_at is null
      and user_id <> target_id
  ) then
    raise exception 'An active verification administrator already exists. Review the existing grant before changing administrators.';
  end if;

  insert into public.verification_admins (user_id, granted_by, revoked_at)
  values (target_id, null, null)
  on conflict (user_id) do update
    set revoked_at = null;

  raise notice 'Verification administrator authorized for Auth user %.', target_id;
end
$bootstrap$;

commit;
