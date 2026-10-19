-- Phase 5: link a creator video to one of that creator's own listings.
-- Run after creator-video-migration.sql.
alter table public.creator_videos add column if not exists listing_id uuid references public.listings(id) on delete set null;
create index if not exists creator_videos_listing_idx on public.creator_videos(listing_id);

create or replace function public.validate_creator_video_listing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.listing_id is not null and not exists (
    select 1 from public.listings l
    where l.id = new.listing_id and l.user_id = new.user_id
  ) then
    raise exception 'Video listing must belong to the video creator';
  end if;
  return new;
end;
$$;
drop trigger if exists creator_video_listing_owner on public.creator_videos;
create trigger creator_video_listing_owner before insert or update of listing_id, user_id on public.creator_videos
for each row execute function public.validate_creator_video_listing();
notify pgrst, 'reload schema';
