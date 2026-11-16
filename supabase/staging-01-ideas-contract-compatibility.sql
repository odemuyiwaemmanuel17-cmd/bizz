-- HustleHub STAGING ONLY: public.ideas contract compatibility.
--
-- Apply to the `hustlehub-staging` project only, immediately after
-- supabase/schema.sql (step 1a of the staging order). Never apply this file to
-- the production project.
--
-- WHY THIS FILE EXISTS
-- schema.sql (the repo baseline) creates public.ideas with the legacy shape:
--   owner_id, title, pitch, category, target_price_cents, image_url, status
-- but the deployed application and the Phase 11/12 administrator RPCs use the
-- live shape:
--   * web/src/lib/ideas.ts                 inserts { user_id, title, description, category }
--   * web/src/lib/ideas.ts                 reads  user_id (ownership) and description (text)
--   * web/src/pages/CreatorProfilePage.tsx selects id,title,description ... eq("user_id", ...)
--   * phase11/phase12 admin_list_ideas     select i.user_id, i.description
--
-- On a fresh staging database built only from the repo, those reads and the
-- admin Ideas view fail. This file makes one database satisfy both contracts by
-- ADDING the live columns and keeping the legacy columns strictly synchronized.
--
-- OWNERSHIP RULES (enforced by trigger, single source of truth per row)
--   INSERT  user_id only        -> owner_id is populated
--   INSERT  owner_id only       -> user_id is populated
--   INSERT  both, equal         -> accepted
--   INSERT  both, different     -> rejected (ideas.ownership_conflict)
--   INSERT  neither             -> rejected (ideas.ownership_required)
--   UPDATE  one side changed    -> the other side follows
--   UPDATE  both changed equal  -> accepted
--   UPDATE  both changed differ -> rejected (ideas.ownership_conflict)
--   UPDATE  either side cleared -> rejected (ownership cannot be cleared)
--
-- TEXT RULES (description is authoritative, pitch mirrors it)
--   INSERT  description only    -> pitch is populated
--   INSERT  pitch only          -> description is populated
--   INSERT  both, different     -> rejected (ideas.text_conflict)
--   UPDATE  description changed -> pitch follows
--   UPDATE  pitch changed       -> description follows
--   UPDATE  both changed differ -> rejected (ideas.text_conflict)
--   Clearing a value            -> the mirrored column is cleared to '' as well,
--                                  so the pair never disagrees.
--
-- SCOPE GUARANTEES
--   * Adds two columns, one index, one trigger function, one trigger, and
--     replaces only the two ideas RLS policies. No table, column, row, or
--     policy is dropped.
--   * Does not touch monetization_plans, monetization_config, Paystack plan
--     codes, prices, billing intervals, creator_subscriptions,
--     payment_transactions, or any Phase 10-17 object.
--   * Refuses to run when existing rows carry conflicting ownership or
--     conflicting text; nothing is overwritten to "resolve" a conflict.
--   * Idempotent and safe to re-run once conflicts are resolved.

begin;

-- ---------------------------------------------------------------------------
-- 1. Preconditions: this file only makes sense on the schema.sql baseline.
--    (A production-shaped table has user_id/description but no owner_id/pitch,
--    so this check also makes an accidental production run fail immediately.)
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.ideas') is null then
    raise exception 'public.ideas is missing. Apply supabase/schema.sql before staging-01-ideas-contract-compatibility.sql.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ideas' and column_name = 'owner_id'
  ) then
    raise exception 'public.ideas.owner_id is missing: this file targets the fresh-staging baseline from schema.sql, not a production-shaped table.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ideas' and column_name = 'pitch'
  ) then
    raise exception 'public.ideas.pitch is missing: this file targets the fresh-staging baseline from schema.sql, not a production-shaped table.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Live-contract columns (additive only)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ideas' and column_name = 'user_id'
  ) then
    alter table public.ideas
      add column user_id uuid references public.profiles(id) on delete cascade;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ideas' and column_name = 'description'
  ) then
    alter table public.ideas add column description text;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Conflict inspection BEFORE any backfill.
--    Conflicting values are never overwritten; the migration stops so the
--    ownership/text question can be answered by a person.
-- ---------------------------------------------------------------------------

do $$
declare
  ownership_conflicts bigint;
  text_conflicts bigint;
begin
  select count(*) into ownership_conflicts
  from public.ideas
  where user_id is not null
    and owner_id is not null
    and user_id <> owner_id;

  if ownership_conflicts > 0 then
    raise exception 'Refusing to apply: % idea row(s) have conflicting user_id and owner_id.', ownership_conflicts
      using hint = 'Inspect with: select id, user_id, owner_id from public.ideas where user_id is distinct from owner_id; then resolve ownership, and re-run this file.';
  end if;

  select count(*) into text_conflicts
  from public.ideas
  where nullif(description, '') is not null
    and nullif(pitch, '') is not null
    and description <> pitch;

  if text_conflicts > 0 then
    raise exception 'Refusing to apply: % idea row(s) have conflicting description and pitch text.', text_conflicts
      using hint = 'Inspect with: select id, description, pitch from public.ideas where nullif(description,'''') is not null and nullif(pitch,'''') is not null and description <> pitch; then align the text, and re-run this file.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Converge rows that are missing a value (NULL/empty only, never a conflict)
--    On a fresh staging database these statements affect zero rows.
-- ---------------------------------------------------------------------------

update public.ideas set user_id = owner_id where user_id is null and owner_id is not null;
update public.ideas set owner_id = user_id where owner_id is null and user_id is not null;
update public.ideas set description = pitch where nullif(description, '') is null and nullif(pitch, '') is not null;
update public.ideas set pitch = description where nullif(pitch, '') is null and nullif(description, '') is not null;

create index if not exists ideas_user_idx on public.ideas(user_id, created_at desc);

-- Ownership is required by the live contract. Only enforce NOT NULL when the
-- data can satisfy it; otherwise leave the column nullable and report it.
do $$
begin
  if not exists (select 1 from public.ideas where user_id is null) then
    alter table public.ideas alter column user_id set not null;
  else
    raise notice 'public.ideas.user_id left nullable: % row(s) have no owner. Resolve ownership, then re-run this file.', (
      select count(*) from public.ideas where user_id is null
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Strict synchronization trigger
-- ---------------------------------------------------------------------------

create or replace function public.sync_idea_contract_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- Ownership -------------------------------------------------------------
    if new.user_id is null and new.owner_id is null then
      raise exception 'ideas.ownership_required: supply user_id or owner_id.'
        using errcode = '23502';
    elsif new.user_id is null then
      new.user_id := new.owner_id;
    elsif new.owner_id is null then
      new.owner_id := new.user_id;
    elsif new.user_id <> new.owner_id then
      raise exception 'ideas.ownership_conflict: user_id (%) and owner_id (%) differ on insert.',
        new.user_id, new.owner_id
        using errcode = '23514',
              hint = 'Supply only one ownership column, or two equal values.';
    end if;

    -- Text ------------------------------------------------------------------
    if nullif(new.description, '') is null and nullif(new.pitch, '') is null then
      new.description := '';
      new.pitch := '';
    elsif nullif(new.description, '') is null then
      new.description := new.pitch;
    elsif nullif(new.pitch, '') is null then
      new.pitch := new.description;
    elsif new.description <> new.pitch then
      raise exception 'ideas.text_conflict: description and pitch differ on insert.'
        using errcode = '23514',
              hint = 'Supply only one text column, or two equal values.';
    end if;
  else
    -- Ownership -------------------------------------------------------------
    if new.user_id is distinct from old.user_id and new.owner_id is distinct from old.owner_id then
      if new.user_id is distinct from new.owner_id then
        raise exception 'ideas.ownership_conflict: user_id and owner_id were both changed to different values.'
          using errcode = '23514';
      end if;
    elsif new.user_id is distinct from old.user_id then
      new.owner_id := new.user_id;
    elsif new.owner_id is distinct from old.owner_id then
      new.user_id := new.owner_id;
    end if;

    if new.user_id is null or new.owner_id is null then
      raise exception 'ideas.ownership_required: ownership columns may not be cleared.'
        using errcode = '23502';
    end if;

    -- Text ------------------------------------------------------------------
    if new.description is distinct from old.description and new.pitch is distinct from old.pitch then
      if coalesce(new.description, '') <> coalesce(new.pitch, '') then
        raise exception 'ideas.text_conflict: description and pitch were both changed to different values.'
          using errcode = '23514';
      end if;
    elsif new.description is distinct from old.description then
      new.pitch := coalesce(new.description, '');
    elsif new.pitch is distinct from old.pitch then
      new.description := coalesce(new.pitch, '');
    end if;

    -- Normalise a cleared value so the pair can never disagree.
    new.description := coalesce(new.description, '');
    new.pitch := coalesce(new.pitch, '');
  end if;

  return new;
end;
$$;

drop trigger if exists sync_idea_contract_columns on public.ideas;
create trigger sync_idea_contract_columns
  before insert or update on public.ideas
  for each row execute function public.sync_idea_contract_columns();

-- ---------------------------------------------------------------------------
-- 6. RLS: same intent as schema.sql, expressed against the live ownership
--    column. Public read stays limited to open ideas; owners always see and
--    manage their own rows; idea voting policies are not touched.
-- ---------------------------------------------------------------------------

alter table public.ideas enable row level security;

drop policy if exists "open ideas readable" on public.ideas;
create policy "open ideas readable"
  on public.ideas for select
  using (status = 'open' or user_id = auth.uid());

drop policy if exists "owner manages ideas" on public.ideas;
create policy "owner manages ideas"
  on public.ideas for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No unintended permissive policy may remain on this table.
do $$
declare
  unexpected text;
begin
  select string_agg(policyname, ', ' order by policyname) into unexpected
  from pg_policies
  where schemaname = 'public'
    and tablename = 'ideas'
    and policyname not in ('open ideas readable', 'owner manages ideas');

  if unexpected is not null then
    raise exception 'Unexpected RLS policy/policies on public.ideas: %. Review them before relying on this table.', unexpected;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
