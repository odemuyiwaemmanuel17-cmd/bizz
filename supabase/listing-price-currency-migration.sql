-- Phase: explicit listing price semantics and ISO currency.
-- Existing rows are preserved: currency/is_free remain NULL until reviewed.
alter table public.listings add column if not exists currency text;
alter table public.listings add column if not exists is_free boolean;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'listings_currency_iso_check') then
    alter table public.listings add constraint listings_currency_iso_check check (currency is null or currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'listings_price_cents_nonnegative') then
    alter table public.listings add constraint listings_price_cents_nonnegative check (price_cents is null or price_cents >= 0);
  end if;
end $$;
notify pgrst, 'reload schema';
