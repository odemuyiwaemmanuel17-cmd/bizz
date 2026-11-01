-- HustleHub Phase 16: enable the configured Paystack TEST MODE provider.
-- Apply after phase15-paystack-plan-code-mapping-migration.sql.
-- Paid promotions remain disabled until separately tested.

begin;
update public.monetization_config
set provider = 'paystack', environment = 'test', payments_enabled = true,
    subscriptions_enabled = true, paid_promotions_enabled = false, updated_at = now()
where id = 1;
do $$
declare config_row public.monetization_config%rowtype;
begin
  select * into config_row from public.monetization_config where id = 1;
  if config_row.provider <> 'paystack' or config_row.environment <> 'test'
    or config_row.payments_enabled is not true
    or config_row.subscriptions_enabled is not true
    or config_row.paid_promotions_enabled is not false then
    raise exception 'Paystack TEST MODE configuration was not applied safely.';
  end if;
end;
$$;
commit;
notify pgrst, 'reload schema';
