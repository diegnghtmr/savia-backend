begin;

-- These flags are shared with the L16 bulk transaction and category writers.
alter table public.categories
  add column if not exists essential boolean not null default false;
alter table public.transactions
  add column if not exists extraordinary boolean not null default false,
  add column if not exists excluded_from_reports boolean not null default false;

grant insert (essential), update (essential) on public.categories to savia_application;
grant update (extraordinary, excluded_from_reports) on public.transactions to savia_application;

-- The rate list belongs to the immutable completed snapshot, not its inputs.
alter table public.report_runs
  add column fx_rates_used jsonb,
  add constraint report_runs_fx_rates_used_check check (
    case when fx_rates_used is null then true
         when jsonb_typeof(fx_rates_used) = 'array' then
           status = 'completed' and jsonb_array_length(fx_rates_used) > 0
         else false end
  );
grant update (fx_rates_used) on public.report_runs to savia_application;

commit;
