-- HustleHub schema patch: creator dashboard support + vote counting.
-- Safe to run multiple times (idempotent). Paste into Supabase SQL Editor and Run.

-- 1) Ensure every auth user has a profile row (fixes "posted but invisible"
--    caused by missing profiles rows from signups before the trigger existed).
insert into public.profiles (id, handle, display_name)
select u.id,
       coalesce(
         nullif(left(lower(regexp_replace(split_part(coalesce(u.email, 'hustler','@'), '@', 1), '[^a-z0-9_]', '', 'g')), 20), ''),
         'hustler'
       ) || '_' || substr(replace(u.id::text, '-', ''), 1, 6),
       coalesce(nullif(split_part(u.email, '@', 1), ''), 'New hustler')
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

-- 2) Auto-create profiles for NEW signups (trigger may be missing if an
--    earlier migration failed halfway).
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

-- 3) votes_count computed column so listings expose their vote tally
--    directly in selects (used by feed cards + creator dashboard).
alter table public.listings
  add column if not exists votes_count integer
  generated always as (
    (select count(*) from public.votes v where v.listing_id = listings.id)
  ) stored;

-- 4) Make sure owner RLS policies exist even if a previous run aborted
--    before applying them (this was why published posts were invisible).
drop policy if exists "owner manages listings" on public.listings;
create policy "owner manages listings" on public.listings
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "active listings public" on public.listings;
create policy "active listings public" on public.listings
  for select using (status = 'active');

drop policy if exists "open ideas readable" on public.ideas;
create policy "open ideas readable" on public.ideas
  for select using (status = 'open' or owner_id = auth.uid());

drop policy if exists "owner manages ideas" on public.ideas;
create policy "owner manages ideas" on public.ideas
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Quick sanity check you can run afterwards:
--   select count(*) from public.listings;
--   select id, title, votes_count from public.listings order by created_at desc limit 10;
