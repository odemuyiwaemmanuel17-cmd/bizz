-- HustleHub STAGING ONLY: operate without Paystack integration.
--
-- Apply to the `hustlehub-staging` project only, as the final step of the
-- staging order (after phase17-paystack-ownership-hardening-migration.sql).
-- Never apply this file to the production project.
--
-- WHY THIS FILE EXISTS
-- phase16-enable-paystack-test-monetization.sql enables payments and
-- subscriptions for TEST MODE. Staging must not reach the existing Paystack
-- test business at all, so all three capabilities are switched off and then
-- locked off.
--
-- WHAT THIS DOES
--   * Sets the three feature switches to false on the single config row.
--   * Adds a staging-only CHECK constraint so the row cannot be flipped back to
--     enabled by a later migration, the Admin Control Center RPC, or a re-run of
--     phase16 (whose UPDATE then fails and rolls its own transaction back).
--   * Leaves provider and environment untouched; the Phase 14 constraint still
--     forbids live mode.
--   * Does not read, write, or assert plan records. No price, billing interval,
--     internal plan code, or Paystack plan code is referenced, asserted, or
--     changed. Prices are owner-managed and are deliberately not treated as
--     canonical anywhere in this file.
--   * Writes no subscription, transaction, webhook, or entitlement record.
--
-- RUNTIME EFFECT (defence in depth)
--   1. web/api/_paystack.mjs enabledConfig() requires payments_enabled = true
--      and the capability flag to be true, so /api/paystack/initialize returns
--      409 "This payment feature is currently disabled." before any Paystack
--      call is attempted.
--   2. Staging must not be given PAYSTACK_SECRET_KEY / PAYSTACK_PUBLIC_KEY. With
--      no secret configured, paystackRequest() returns 503 and the webhook
--      handler answers 503, so no provider request and no webhook processing is
--      possible even if the constraint were removed.
--
-- Idempotent: safe to re-run. To intentionally enable a capability later (only
-- once a dedicated staging Paystack test account exists), drop the guard first:
--   alter table public.monetization_config
--     drop constraint staging_requires_payments_disabled;

begin;

do $$
begin
  if not exists (select 1 from public.monetization_config where id = 1) then
    raise exception 'monetization_config row 1 is missing. Apply phase10-monetization-migration.sql before this staging file.';
  end if;
end;
$$;

-- Re-runnable: replace any earlier version of the guard before re-asserting it.
alter table public.monetization_config
  drop constraint if exists staging_requires_payments_disabled;

update public.monetization_config
set payments_enabled = false,
    subscriptions_enabled = false,
    paid_promotions_enabled = false,
    updated_at = now()
where id = 1;

do $$
declare
  config_row public.monetization_config%rowtype;
begin
  select * into config_row from public.monetization_config where id = 1;
  if config_row.payments_enabled is not false
     or config_row.subscriptions_enabled is not false
     or config_row.paid_promotions_enabled is not false then
    raise exception 'Staging payment capabilities were not disabled safely.';
  end if;
  if config_row.environment not in ('disabled', 'test') then
    raise exception 'Unexpected monetization environment %; staging must stay in test/disabled.', config_row.environment;
  end if;
end;
$$;

-- Guard: while this staging constraint exists, no statement can set any of the
-- three capabilities back to true on this database. That is what makes a
-- re-run of phase16 fail instead of silently re-enabling payments in staging.
alter table public.monetization_config
  add constraint staging_requires_payments_disabled
  check (payments_enabled is not true
         and subscriptions_enabled is not true
         and paid_promotions_enabled is not true);

do $$
declare
  guard_present boolean;
begin
  select exists (
    select 1 from pg_constraint
    where conrelid = 'public.monetization_config'::regclass
      and conname = 'staging_requires_payments_disabled'
      and contype = 'c'
  ) into guard_present;
  if guard_present is not true then
    raise exception 'staging_requires_payments_disabled guard was not created.';
  end if;
end;
$$;

commit;
