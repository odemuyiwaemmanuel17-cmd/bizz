-- HustleHub Phase 11: secure Admin Control Center.
-- Apply after phase7-community-trust-migration.sql,
-- creator-verification-admin-migration.sql, phase8-marketplace-growth-migration.sql,
-- and phase10-monetization-migration.sql.

create extension if not exists pgcrypto;

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  administrator_id uuid not null references public.profiles(id) on delete restrict,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  previous_data jsonb,
  new_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_logs_created_idx on public.admin_audit_logs(created_at desc);
create index if not exists admin_audit_logs_entity_idx on public.admin_audit_logs(entity_type, entity_id, created_at desc);
alter table public.admin_audit_logs enable row level security;
drop policy if exists "admins read admin audit logs" on public.admin_audit_logs;
create policy "admins read admin audit logs"
  on public.admin_audit_logs for select
  using (public.is_verification_admin());

create or replace function public.require_verification_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_verification_admin() then
    raise exception 'Verification administrator access required.';
  end if;
end;
$$;
revoke all on function public.require_verification_admin() from public;
grant execute on function public.require_verification_admin() to authenticated;

create or replace function public.write_admin_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_previous_data jsonb,
  p_new_data jsonb,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare audit_id uuid;
begin
  perform public.require_verification_admin();
  insert into public.admin_audit_logs
    (administrator_id, action, entity_type, entity_id, previous_data, new_data, reason)
  values
    (auth.uid(), p_action, p_entity_type, p_entity_id, p_previous_data, p_new_data, nullif(trim(coalesce(p_reason, '')), ''))
  returning id into audit_id;
  return audit_id;
end;
$$;
revoke all on function public.write_admin_audit(text, text, uuid, jsonb, jsonb, text) from public;

-- -------------------------------------------------------------------------
-- Overview and records
-- -------------------------------------------------------------------------

create or replace function public.admin_platform_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  perform public.require_verification_admin();
  select jsonb_build_object(
    'totalUsers', (select count(*) from public.profiles),
    'newUsers', (select count(*) from public.profiles where created_at >= now() - interval '30 days'),
    'totalCreators', (select count(*) from public.profiles),
    'verifiedCreators', (select count(*) from public.profiles where is_verified = true),
    'publishedVideos', (select count(*) from public.creator_videos where status = 'published'),
    'totalListings', (select count(*) from public.listings),
    'activeListings', (select count(*) from public.listings where status = 'active'),
    'totalIdeas', (select count(*) from public.ideas),
    'validationVotes', (select count(*) from public.idea_votes),
    'likes', (select count(*) from public.video_likes),
    'saves', (select count(*) from public.saved_videos),
    'comments', (select count(*) from public.video_comments),
    'follows', (select count(*) from public.creator_follows),
    'pendingVerification', (select count(*) from public.creator_verification_requests where status = 'pending'),
    'promotionRequests', (select count(*) from public.promotion_requests where status = 'pending'),
    'activePromotions', (select count(*) from public.promotion_orders where status = 'active' and ends_at > now()),
    'paymentRecords', (select count(*) from public.payment_transactions),
    'confirmedPayments', (select count(*) from public.payment_transactions where status = 'succeeded'),
    'paymentEnvironment', (select environment from public.monetization_config where id = 1),
    'recentActivity', coalesce((
      select jsonb_agg(recent.payload order by recent.created_at desc)
      from (
        select * from (
          select p.created_at, jsonb_build_object('kind', 'user', 'label', 'New user profile', 'entityId', p.id, 'createdAt', p.created_at) as payload from public.profiles p
          union all
          select v.created_at, jsonb_build_object('kind', 'video', 'label', 'Creator video', 'entityId', v.id, 'createdAt', v.created_at) from public.creator_videos v
          union all
          select l.created_at, jsonb_build_object('kind', 'listing', 'label', 'Bizz listing', 'entityId', l.id, 'createdAt', l.created_at) from public.listings l
          union all
          select i.created_at, jsonb_build_object('kind', 'idea', 'label', 'Validation idea', 'entityId', i.id, 'createdAt', i.created_at) from public.ideas i
          union all
          select r.created_at, jsonb_build_object('kind', 'verification', 'label', 'Verification application', 'entityId', r.id, 'createdAt', r.created_at) from public.creator_verification_requests r
        ) all_activity
        order by created_at desc
        limit 12
      ) recent
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.admin_platform_overview() from public;
grant execute on function public.admin_platform_overview() to authenticated;

drop function if exists public.admin_list_profiles(text, integer, integer);
create or replace function public.admin_list_profiles(
  p_search text default null,
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  id uuid, display_name text, email text, username text, avatar_url text,
  is_verified boolean, created_at timestamptz, total_count bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select p.id, coalesce(p.display_name, p.username, 'Unnamed user'), p.email, p.username,
         p.avatar_url, coalesce(p.is_verified, false), p.created_at, count(*) over()
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

create or replace function public.admin_list_videos(
  p_search text default null,
  p_status text default null,
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  id uuid, user_id uuid, creator_name text, username text, status text,
  caption text, video_url text, listing_id uuid, created_at timestamptz, total_count bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select v.id, v.user_id, coalesce(p.display_name, p.username, 'Unnamed creator'), p.username,
         v.status, v.caption, v.video_url, v.listing_id, v.created_at, count(*) over()
  from public.creator_videos v
  left join public.profiles p on p.id = v.user_id
  where (nullif(trim(coalesce(p_status, '')), '') is null or v.status = p_status)
    and (nullif(trim(coalesce(p_search, '')), '') is null
      or lower(coalesce(v.caption, '')) like '%' || lower(trim(p_search)) || '%'
      or lower(coalesce(p.username, p.display_name, '')) like '%' || lower(trim(p_search)) || '%'
      or v.id::text = trim(p_search))
  order by v.created_at desc
  offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
  limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_videos(text, text, integer, integer) from public;
grant execute on function public.admin_list_videos(text, text, integer, integer) to authenticated;

create or replace function public.admin_list_listings(
  p_search text default null,
  p_status text default null,
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  id uuid, user_id uuid, owner_name text, title text, category text, status text,
  price_cents bigint, currency text, created_at timestamptz, total_count bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select l.id, l.user_id, coalesce(p.display_name, p.username, 'Unnamed creator'), l.title,
         l.category, l.status, l.price_cents, l.currency, l.created_at, count(*) over()
  from public.listings l
  left join public.profiles p on p.id = l.user_id
  where (nullif(trim(coalesce(p_status, '')), '') is null or l.status = p_status)
    and (nullif(trim(coalesce(p_search, '')), '') is null
      or lower(l.title) like '%' || lower(trim(p_search)) || '%'
      or lower(coalesce(l.description, '')) like '%' || lower(trim(p_search)) || '%'
      or l.id::text = trim(p_search))
  order by l.created_at desc
  offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
  limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_listings(text, text, integer, integer) from public;
grant execute on function public.admin_list_listings(text, text, integer, integer) to authenticated;

drop function if exists public.admin_list_ideas(text, text, integer, integer);
create or replace function public.admin_list_ideas(
  p_search text default null,
  p_status text default null,
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  id uuid, user_id uuid, owner_name text, title text, description text, category text,
  vote_count bigint, created_at timestamptz, total_count bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select i.id, i.user_id, coalesce(p.display_name, p.username, 'Unnamed creator'), i.title,
         i.description, i.category, (select count(*) from public.idea_votes iv where iv.idea_id = i.id), i.created_at, count(*) over()
  from public.ideas i
  left join public.profiles p on p.id = i.user_id
  where (nullif(trim(coalesce(p_search, '')), '') is null
      or lower(i.title) like '%' || lower(trim(p_search)) || '%'
      or lower(coalesce(i.description, '')) like '%' || lower(trim(p_search)) || '%'
      or i.id::text = trim(p_search))
  order by i.created_at desc
  offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
  limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_ideas(text, text, integer, integer) from public;
grant execute on function public.admin_list_ideas(text, text, integer, integer) to authenticated;

create or replace function public.admin_list_reports(
  p_status text default null,
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  report_type text, id uuid, target_id uuid, reporter_id uuid, reporter_name text,
  reason text, status text, created_at timestamptz, total_count bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select reports.report_type, reports.id, reports.target_id, reports.reporter_id,
         coalesce(p.display_name, p.username, 'Unknown user'), reports.reason, reports.status,
         reports.created_at, count(*) over()
  from (
    select 'listing'::text as report_type, r.id, r.listing_id as target_id, r.reporter_id, r.reason, r.status, r.created_at from public.listing_reports r
    union all
    select 'comment'::text, r.id, r.comment_id, r.reporter_id, r.reason, r.status, r.created_at from public.video_comment_reports r
  ) reports
  left join public.profiles p on p.id = reports.reporter_id
  where nullif(trim(coalesce(p_status, '')), '') is null or reports.status = p_status
  order by reports.created_at desc
  offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
  limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_reports(text, integer, integer) from public;
grant execute on function public.admin_list_reports(text, integer, integer) to authenticated;

create or replace function public.admin_list_promotion_requests(
  p_status text default null,
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  id uuid, listing_id uuid, listing_title text, creator_id uuid, creator_name text,
  note text, status text, created_at timestamptz, total_count bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select r.id, r.listing_id, coalesce(l.title, 'Bizz'), r.creator_id,
         coalesce(p.display_name, p.username, 'Unnamed creator'), r.note, r.status, r.created_at, count(*) over()
  from public.promotion_requests r
  left join public.listings l on l.id = r.listing_id
  left join public.profiles p on p.id = r.creator_id
  where nullif(trim(coalesce(p_status, '')), '') is null or r.status = p_status
  order by r.created_at desc
  offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
  limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_promotion_requests(text, integer, integer) from public;
grant execute on function public.admin_list_promotion_requests(text, integer, integer) to authenticated;

create or replace function public.admin_list_audit_logs(
  p_page integer default 0,
  p_page_size integer default 25
)
returns table (
  id uuid, administrator_id uuid, administrator_name text, action text, entity_type text,
  entity_id uuid, previous_data jsonb, new_data jsonb, reason text, created_at timestamptz, total_count bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_verification_admin();
  return query
  select a.id, a.administrator_id, coalesce(p.display_name, p.username, 'Administrator'), a.action,
         a.entity_type, a.entity_id, a.previous_data, a.new_data, a.reason, a.created_at, count(*) over()
  from public.admin_audit_logs a
  left join public.profiles p on p.id = a.administrator_id
  order by a.created_at desc
  offset greatest(coalesce(p_page, 0), 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
  limit least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;
revoke all on function public.admin_list_audit_logs(integer, integer) from public;
grant execute on function public.admin_list_audit_logs(integer, integer) to authenticated;

-- -------------------------------------------------------------------------
-- Audited moderation actions
-- -------------------------------------------------------------------------

create or replace function public.admin_moderate_video(p_video_id uuid, p_action text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare before_row public.creator_videos%rowtype; next_status text;
begin
  perform public.require_verification_admin();
  if p_action not in ('hide', 'restore') then raise exception 'Unsupported video action.'; end if;
  select * into before_row from public.creator_videos where id = p_video_id for update;
  if not found then raise exception 'Video not found.'; end if;
  next_status := case when p_action = 'hide' then 'private' else 'published' end;
  update public.creator_videos set status = next_status where id = p_video_id;
  insert into public.admin_audit_logs(administrator_id, action, entity_type, entity_id, previous_data, new_data, reason)
  values (auth.uid(), p_action, 'video', p_video_id, jsonb_build_object('status', before_row.status), jsonb_build_object('status', next_status), nullif(trim(coalesce(p_reason, '')), ''));
  return jsonb_build_object('id', p_video_id, 'status', next_status);
end;
$$;
revoke all on function public.admin_moderate_video(uuid, text, text) from public;
grant execute on function public.admin_moderate_video(uuid, text, text) to authenticated;

create or replace function public.admin_moderate_listing(p_listing_id uuid, p_action text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare before_row public.listings%rowtype; next_status text;
begin
  perform public.require_verification_admin();
  if p_action not in ('archive', 'restore') then raise exception 'Unsupported listing action.'; end if;
  select * into before_row from public.listings where id = p_listing_id for update;
  if not found then raise exception 'Listing not found.'; end if;
  next_status := case when p_action = 'archive' then 'archived' else 'active' end;
  update public.listings set status = next_status, updated_at = now() where id = p_listing_id;
  insert into public.admin_audit_logs(administrator_id, action, entity_type, entity_id, previous_data, new_data, reason)
  values (auth.uid(), p_action, 'listing', p_listing_id, jsonb_build_object('status', before_row.status), jsonb_build_object('status', next_status), nullif(trim(coalesce(p_reason, '')), ''));
  return jsonb_build_object('id', p_listing_id, 'status', next_status);
end;
$$;
revoke all on function public.admin_moderate_listing(uuid, text, text) from public;
grant execute on function public.admin_moderate_listing(uuid, text, text) to authenticated;

drop function if exists public.admin_moderate_idea(uuid, text, text);

create or replace function public.admin_update_report(p_report_type text, p_report_id uuid, p_status text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare old_status text; target_id uuid;
begin
  perform public.require_verification_admin();
  if p_status not in ('pending', 'reviewed', 'dismissed', 'actioned') then raise exception 'Unsupported report status.'; end if;
  if p_report_type = 'listing' then
    select status, listing_id into old_status, target_id from public.listing_reports where id = p_report_id for update;
    if old_status is null then raise exception 'Listing report not found.'; end if;
    update public.listing_reports set status = p_status where id = p_report_id;
  elsif p_report_type = 'comment' then
    select status, comment_id into old_status, target_id from public.video_comment_reports where id = p_report_id for update;
    if old_status is null then raise exception 'Comment report not found.'; end if;
    update public.video_comment_reports set status = p_status where id = p_report_id;
  else
    raise exception 'Unsupported report type.';
  end if;
  insert into public.admin_audit_logs(administrator_id, action, entity_type, entity_id, previous_data, new_data, reason)
  values (auth.uid(), 'update_report', p_report_type || '_report', p_report_id, jsonb_build_object('status', old_status), jsonb_build_object('status', p_status, 'targetId', target_id), nullif(trim(coalesce(p_reason, '')), ''));
  return jsonb_build_object('id', p_report_id, 'status', p_status);
end;
$$;
revoke all on function public.admin_update_report(text, uuid, text, text) from public;
grant execute on function public.admin_update_report(text, uuid, text, text) to authenticated;

create or replace function public.admin_update_promotion_request(p_request_id uuid, p_status text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare old_status text; listing_id uuid;
begin
  perform public.require_verification_admin();
  if p_status not in ('pending', 'approved', 'rejected', 'cancelled') then raise exception 'Unsupported promotion request status.'; end if;
  select status, promotion_requests.listing_id into old_status, listing_id from public.promotion_requests where id = p_request_id for update;
  if old_status is null then raise exception 'Promotion request not found.'; end if;
  update public.promotion_requests set status = p_status where id = p_request_id;
  insert into public.admin_audit_logs(administrator_id, action, entity_type, entity_id, previous_data, new_data, reason)
  values (auth.uid(), 'update_promotion_request', 'promotion_request', p_request_id, jsonb_build_object('status', old_status), jsonb_build_object('status', p_status, 'listingId', listing_id), nullif(trim(coalesce(p_reason, '')), ''));
  return jsonb_build_object('id', p_request_id, 'status', p_status);
end;
$$;
revoke all on function public.admin_update_promotion_request(uuid, text, text) from public;
grant execute on function public.admin_update_promotion_request(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
