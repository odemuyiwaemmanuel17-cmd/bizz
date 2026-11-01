-- HustleHub Phase 15: connect confirmed Paystack TEST MODE plan codes.
-- Apply after phase14-paystack-hardening-migration.sql.
--
-- Stable monetization_plans.code values are used deliberately. This migration
-- does not rely on row order and does not create or delete plan records.

begin;

do $$
begin
  if not exists (
    select 1 from public.monetization_plans
    where code = 'pro_monthly'
      and name = 'HustleHub Pro'
      and price_cents = 350000
      and currency = 'NGN'
      and billing_interval = 'month'
      and audience = 'creator'
      and active = true
  ) then
    raise exception 'Expected pro_monthly plan metadata was not found.';
  end if;
  if not exists (
    select 1 from public.monetization_plans
    where code = 'pro_yearly'
      and name = 'HustleHub Pro Annual'
      and price_cents = 3500000
      and currency = 'NGN'
      and billing_interval = 'year'
      and audience = 'creator'
      and active = true
  ) then
    raise exception 'Expected pro_yearly plan metadata was not found.';
  end if;
  if not exists (
    select 1 from public.monetization_plans
    where code = 'business_monthly'
      and name = 'HustleHub Business'
      and price_cents = 1000000
      and currency = 'NGN'
      and billing_interval = 'month'
      and audience = 'business'
      and active = true
  ) then
    raise exception 'Expected business_monthly plan metadata was not found.';
  end if;
  if not exists (
    select 1 from public.monetization_plans
    where code = 'business_yearly'
      and name = 'HustleHub Business Annual'
      and price_cents = 10000000
      and currency = 'NGN'
      and billing_interval = 'year'
      and audience = 'business'
      and active = true
  ) then
    raise exception 'Expected business_yearly plan metadata was not found.';
  end if;
end;
$$;

-- The partial unique index from Phase 13 prevents two plans from sharing a
-- Paystack code. Only the four corresponding code fields are changed here.
update public.monetization_plans
set paystack_plan_code = case code
  when 'pro_monthly' then 'PLN_6p9eo2b5a0cnx05'
  when 'pro_yearly' then 'PLN_8wiiuss56fdmw53'
  when 'business_monthly' then 'PLN_6dlmnyi74htaaeo'
  when 'business_yearly' then 'PLN_nue9pa3enus4q9n'
end,
updated_at = now()
where code in ('pro_monthly', 'pro_yearly', 'business_monthly', 'business_yearly');

do $$
declare
  mapped_count integer;
begin
  select count(*) into mapped_count
  from public.monetization_plans
  where code in ('pro_monthly', 'pro_yearly', 'business_monthly', 'business_yearly')
    and paystack_plan_code is not null;
  if mapped_count <> 4 then
    raise exception 'Expected four mapped Paystack plans, found %.', mapped_count;
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';
