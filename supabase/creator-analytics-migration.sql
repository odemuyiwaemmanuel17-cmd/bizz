-- Phase 6: private creator analytics with server-derived ownership.
-- Run this complete file in Supabase SQL Editor. It is additive and idempotent.

create extension if not exists pgcrypto;

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null check (event_name in (
    'video_view',
    'video_like',
    'video_save',
    'profile_view',
    'bizz_view',
    'video_to_bizz_click',
    'contact_click'
  )),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  video_id uuid references public.creator_videos(id) on delete cascade,
  listing_id uuid references public.listings(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  dedupe_hash text,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_creator_time_idx
  on public.analytics_events(creator_id, created_at desc);
create index if not exists analytics_events_video_time_idx
  on public.analytics_events(video_id, event_name, created_at desc)
  where video_id is not null;
create index if not exists analytics_events_listing_time_idx
  on public.analytics_events(listing_id, event_name, created_at desc)
  where listing_id is not null;
create unique index if not exists analytics_events_dedupe_idx
  on public.analytics_events(dedupe_hash)
  where dedupe_hash is not null;

alter table public.analytics_events enable row level security;
-- No direct SELECT/INSERT policies are intentional. Clients use the two
-- SECURITY DEFINER functions below, which derive ownership from content rows.

create or replace function public.record_analytics_event(
  p_event_name text,
  p_video_id uuid default null,
  p_listing_id uuid default null,
  p_profile_id uuid default null,
  p_dedupe_key text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_creator_id uuid;
  v_actor_user_id uuid := auth.uid();
  v_dedupe_hash text;
begin
  if p_event_name not in (
    'video_view', 'video_like', 'video_save', 'profile_view',
    'bizz_view', 'video_to_bizz_click', 'contact_click'
  ) then
    raise exception 'Unsupported analytics event';
  end if;

  if p_event_name in ('video_like', 'video_save') and v_actor_user_id is null then
    raise exception 'Authentication required for this analytics event';
  end if;

  if p_event_name in ('video_view', 'video_like', 'video_save', 'video_to_bizz_click') then
    select v.user_id into v_creator_id
    from public.creator_videos v
    where v.id = p_video_id
      and v.status = 'published';
    if v_creator_id is null then
      raise exception 'Published video not found';
    end if;
  elsif p_event_name in ('bizz_view', 'contact_click') then
    select l.user_id into v_creator_id
    from public.listings l
    where l.id = p_listing_id
      and l.status = 'active';
    if v_creator_id is null then
      raise exception 'Active Bizz not found';
    end if;
  else
    select p.id into v_creator_id
    from public.profiles p
    where p.id = p_profile_id;
    if v_creator_id is null then
      raise exception 'Creator profile not found';
    end if;
  end if;

  if p_event_name = 'video_to_bizz_click' then
    if p_listing_id is null or not exists (
      select 1
      from public.creator_videos v
      join public.listings l on l.id = v.listing_id
      where v.id = p_video_id
        and v.listing_id = p_listing_id
        and v.status = 'published'
        and l.status = 'active'
        and l.user_id = v.user_id
    ) then
      raise exception 'Video-to-Bizz association not found';
    end if;
  elsif p_event_name = 'video_like' then
    if not exists (select 1 from public.video_likes where video_id = p_video_id and user_id = v_actor_user_id) then
      raise exception 'Video like is not active';
    end if;
  elsif p_event_name = 'video_save' then
    if not exists (select 1 from public.saved_videos where video_id = p_video_id and user_id = v_actor_user_id) then
      raise exception 'Video save is not active';
    end if;
  end if;

  if p_dedupe_key is not null and length(trim(p_dedupe_key)) > 0 then
    v_dedupe_hash := encode(digest(trim(p_dedupe_key), 'sha256'), 'hex');
  end if;

  insert into public.analytics_events (
    event_name, creator_id, video_id, listing_id, profile_id,
    actor_user_id, dedupe_hash
  ) values (
    p_event_name, v_creator_id, p_video_id, p_listing_id, p_profile_id,
    v_actor_user_id, v_dedupe_hash
  ) on conflict (dedupe_hash) where dedupe_hash is not null do nothing;
end
$fn$;

create or replace function public.get_creator_analytics(
  p_creator_id uuid,
  p_from timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_from timestamptz := coalesce(p_from, '-infinity'::timestamptz);
  v_to timestamptz := now();
  v_result jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_creator_id then
    raise exception 'You may only view your own analytics';
  end if;

  select jsonb_build_object(
    'totals', jsonb_build_object(
      'videoViews', (select count(*) from public.analytics_events e where e.creator_id = p_creator_id and e.event_name = 'video_view' and e.created_at >= v_from and e.created_at <= v_to),
      'profileVisits', (select count(*) from public.analytics_events e where e.creator_id = p_creator_id and e.event_name = 'profile_view' and e.created_at >= v_from and e.created_at <= v_to),
      'bizzViews', (select count(*) from public.analytics_events e where e.creator_id = p_creator_id and e.event_name = 'bizz_view' and e.created_at >= v_from and e.created_at <= v_to),
      'videoToBizzClicks', (select count(*) from public.analytics_events e where e.creator_id = p_creator_id and e.event_name = 'video_to_bizz_click' and e.created_at >= v_from and e.created_at <= v_to),
      'contactClicks', (select count(*) from public.analytics_events e where e.creator_id = p_creator_id and e.event_name = 'contact_click' and e.created_at >= v_from and e.created_at <= v_to),
      'likes', (select count(*) from public.video_likes l join public.creator_videos v on v.id = l.video_id where v.user_id = p_creator_id),
      'saves', (select count(*) from public.saved_videos s join public.creator_videos v on v.id = s.video_id where v.user_id = p_creator_id)
    ),
    'trends', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', day::date,
        'videoViews', video_views,
        'profileVisits', profile_visits,
        'bizzViews', bizz_views,
        'videoToBizzClicks', video_to_bizz_clicks,
        'contactClicks', contact_clicks
      ) order by day)
      from (
        select date_trunc('day', e.created_at) as day,
          count(*) filter (where e.event_name = 'video_view') as video_views,
          count(*) filter (where e.event_name = 'profile_view') as profile_visits,
          count(*) filter (where e.event_name = 'bizz_view') as bizz_views,
          count(*) filter (where e.event_name = 'video_to_bizz_click') as video_to_bizz_clicks,
          count(*) filter (where e.event_name = 'contact_click') as contact_clicks
        from public.analytics_events e
        where e.creator_id = p_creator_id and e.created_at >= v_from and e.created_at <= v_to
        group by date_trunc('day', e.created_at)
      ) trend_rows
    ), '[]'::jsonb),
    'topVideos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', video_id,
        'title', title,
        'videoUrl', video_url,
        'views', views,
        'likes', likes,
        'saves', saves,
        'bizzClicks', bizz_clicks
      ) order by views desc, likes desc, saves desc)
      from (
        select v.id as video_id,
          coalesce(nullif(trim(v.caption), ''), 'Published video') as title,
          v.video_url,
          count(e.id) filter (where e.event_name = 'video_view' and e.created_at >= v_from and e.created_at <= v_to) as views,
          (select count(*) from public.video_likes l where l.video_id = v.id) as likes,
          (select count(*) from public.saved_videos s where s.video_id = v.id) as saves,
          count(e.id) filter (where e.event_name = 'video_to_bizz_click' and e.created_at >= v_from and e.created_at <= v_to) as bizz_clicks
        from public.creator_videos v
        left join public.analytics_events e on e.video_id = v.id
        where v.user_id = p_creator_id and v.status = 'published'
        group by v.id, v.caption, v.video_url
        order by views desc, likes desc, saves desc
        limit 5
      ) video_rows
    ), '[]'::jsonb),
    'topBizzes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', listing_id,
        'title', title,
        'imageUrl', image_url,
        'views', views,
        'videoClicks', video_clicks,
        'contactClicks', contact_clicks
      ) order by views desc, video_clicks desc, contact_clicks desc)
      from (
        select l.id as listing_id,
          l.title,
          l.image_url,
          count(e.id) filter (where e.event_name = 'bizz_view' and e.created_at >= v_from and e.created_at <= v_to) as views,
          count(e.id) filter (where e.event_name = 'video_to_bizz_click' and e.created_at >= v_from and e.created_at <= v_to) as video_clicks,
          count(e.id) filter (where e.event_name = 'contact_click' and e.created_at >= v_from and e.created_at <= v_to) as contact_clicks
        from public.listings l
        left join public.analytics_events e on e.listing_id = l.id
        where l.user_id = p_creator_id and l.status = 'active'
        group by l.id, l.title, l.image_url
        order by views desc, video_clicks desc, contact_clicks desc
        limit 5
      ) bizz_rows
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end
$fn$;

revoke all on function public.record_analytics_event(text, uuid, uuid, uuid, text) from public;
grant execute on function public.record_analytics_event(text, uuid, uuid, uuid, text) to anon, authenticated;
revoke all on function public.get_creator_analytics(uuid, timestamptz) from public;
grant execute on function public.get_creator_analytics(uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
