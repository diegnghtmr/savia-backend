begin;

-- A system publication has no user creator. Do not relax attribution for
-- existing sources, or let application users claim the system source.
alter table public.exchange_rates
  alter column created_by drop not null,
  add constraint exchange_rates_system_provenance_check check (
    (source <> 'frankfurter' and created_by is not null)
    or (
      source = 'frankfurter' and created_by is null
      and not manual and notes is null
      and isfinite(effective_at)
      and effective_at = date_trunc('day', effective_at, 'UTC')
      and rate < 'Infinity'::numeric
    )
  ),
  drop constraint exchange_rates_workspace_pair_effective_at_key;

-- Keep the existing duplicate behavior (and error name) for existing sources.
-- A Frankfurter publication may coexist with a manual quote at UTC midnight.
create unique index exchange_rates_workspace_pair_effective_at_key
  on public.exchange_rates (workspace_id, base_currency, quote_currency, effective_at)
  where source <> 'frankfurter';
create unique index exchange_rates_frankfurter_workspace_pair_date_key
  on public.exchange_rates (workspace_id, base_currency, quote_currency, effective_at)
  where source = 'frankfurter';

-- ADR-0020: the worker itself still has no table grants. The wrapper owner
-- gets only the insert columns needed here and FORCE RLS still applies.
grant insert (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual)
  on public.exchange_rates to savia_elevated;
create policy elevated_inserts_frankfurter_rates on public.exchange_rates
  for insert to savia_elevated with check (source = 'frankfurter');

create function public.append_frankfurter_rates(p_rates jsonb)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  insert into public.exchange_rates (
    workspace_id, base_currency, quote_currency, rate, effective_at, source, manual
  )
  select workspace_id, base_currency, quote_currency, rate::numeric,
         effective_on::timestamp at time zone 'UTC', 'frankfurter', false
    from jsonb_to_recordset(p_rates) as batch (
      workspace_id uuid, base_currency text, quote_currency text,
      rate text, effective_on date
    )
  on conflict (workspace_id, base_currency, quote_currency, effective_at)
    where source = 'frankfurter' do nothing;
$$;

revoke all on function public.append_frankfurter_rates(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.append_frankfurter_rates(jsonb) to savia_worker;

grant create on schema public to savia_elevated;
alter function public.append_frankfurter_rates(jsonb) owner to savia_elevated;
revoke create on schema public from savia_elevated;

commit;
