-- HustleHub Phase 12: align administrator RPCs with the live profile and ideas
-- contracts. Apply after phase11-admin-control-center-migration.sql.
--
-- The deployed public.profiles contract uses username/display_name/email and
-- does not expose handle. The deployed public.ideas contract uses user_id and
-- description and does not expose owner_id, pitch, or status.

create extension if not exists pgcrypto;

drop function if exists public.admin_list_profiles(text, integer, integer);
create function public.admin_list_profiles(
  p_search text default null,
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  id uuid,
  display_name text,
  email text,
  username text,
  avatar_url text,
  is_verified boolean,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select p.id,
         coalesce(p.display_name, p.username, 'Unnamed user'),
         p.email,
         p.username,
         p.avatar_url,
         coalesce(p.is_verified, false),
         p.created_at,
         count(*) over()
  from public.profiles p
  where nullif(trim(coalesce(p_search, '')), '') is null
     or lower(coalesce(p.display_name, p.username, '')) like '%' || lower(trim(p_search)) || '%'
     or lower(coalesce(p.username, '')) like '%' || lower(trim(p_search)) || '%'
     or lower(coalesce(p.email, '')) like '%' || lower(trim(p_search)) || '%'
     or p.id::text = trim(p_search)
  order by p.created_at desc
  offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
  limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_profiles(text, integer, integer) from public;
grant execute on function public.admin_list_profiles(text, integer, integer) to authenticated;

drop function if exists public.admin_list_ideas(text, text, integer, integer);
create function public.admin_list_ideas(
  p_search text default null,
  p_status text default null,
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  id uuid,
  user_id uuid,
  owner_name text,
  title text,
  description text,
  category text,
  vote_count bigint,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select i.id,
         i.user_id,
         coalesce(p.display_name, p.username, 'Unnamed creator'),
         i.title,
         i.description,
         i.category,
         (select count(*) from public.idea_votes iv where iv.idea_id = i.id),
         i.created_at,
         count(*) over()
  from public.ideas i
  left join public.profiles p on p.id = i.user_id
  where nullif(trim(coalesce(p_search, '')), '') is null
     or lower(i.title) like '%' || lower(trim(p_search)) || '%'
     or lower(coalesce(i.description, '')) like '%' || lower(trim(p_search)) || '%'
     or i.id::text = trim(p_search)
  order by i.created_at desc
  offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
  limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_ideas(text, text, integer, integer) from public;
grant execute on function public.admin_list_ideas(text, text, integer, integer) to authenticated;

drop function if exists public.admin_moderate_idea(uuid, text, text);

-- Recreate the verification queue RPC in the same migration so a production
-- database that still has an older function body receives the current,
-- creator_id-based relationship without changing the verification schema.
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
      or lower(coalesce(p.display_name, p.username, '')) like '%' || lower(trim(p_search)) || '%'
      or r.id::text = trim(p_search)
    )
  order by r.created_at desc;
end;
$$;
revoke all on function public.admin_list_creator_verification_requests(text, text) from public;
grant execute on function public.admin_list_creator_verification_requests(text, text) to authenticated;

notify pgrst, 'reload schema';
