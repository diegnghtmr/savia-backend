begin;

-- Budgets freeze their currency, so every account currency represented in a
-- workspace must already have a conversion rate into each budget currency.
-- exchange_rates is append-only; this makes the guarantee monotonic and keeps
-- every BudgetAllocation.actual answerable without an error field.

grant usage, create on schema public to savia_elevated;
grant select on public.budgets, public.budget_allocations to savia_elevated;
create policy elevated_reads_budgets
  on public.budgets
  for select
  to savia_elevated
  using (true);

create function public.enforce_budget_currency_has_exchange_rates()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));

  if exists (
    select 1
      from public.accounts account
     where account.workspace_id = new.workspace_id
       and account.currency <> new.currency
       and not exists (
         select 1
           from public.exchange_rates rate
          where rate.workspace_id = new.workspace_id
            and rate.base_currency = account.currency
            and rate.quote_currency = new.currency
       )
  ) then
    raise exception 'budget currency requires exchange rates for all account currencies'
      using errcode = 'check_violation',
            constraint = 'budgets_currency_requires_account_exchange_rates';
  end if;

  return new;
end;
$$;

alter function public.enforce_budget_currency_has_exchange_rates() owner to savia_elevated;

create function public.enforce_account_currency_has_budget_rates()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));

  if exists (
    select 1
      from public.budgets budget
     where budget.workspace_id = new.workspace_id
       and budget.currency <> new.currency
       and not exists (
         select 1
           from public.exchange_rates rate
          where rate.workspace_id = new.workspace_id
            and rate.base_currency = new.currency
            and rate.quote_currency = budget.currency
       )
  ) then
    raise exception 'account currency requires exchange rates for all budget currencies'
      using errcode = 'check_violation',
            constraint = 'accounts_currency_requires_budget_exchange_rates';
  end if;

  return new;
end;
$$;

alter function public.enforce_account_currency_has_budget_rates() owner to savia_elevated;

revoke create on schema public from savia_elevated;

revoke execute on function public.enforce_budget_currency_has_exchange_rates() from public;
revoke execute on function public.enforce_account_currency_has_budget_rates() from public;

create trigger enforce_budget_currency_has_exchange_rates_trigger
before insert or update of currency, workspace_id on public.budgets
for each row execute function public.enforce_budget_currency_has_exchange_rates();

create trigger enforce_account_currency_has_budget_rates_trigger
before insert or update of currency, workspace_id on public.accounts
for each row execute function public.enforce_account_currency_has_budget_rates();

commit;
