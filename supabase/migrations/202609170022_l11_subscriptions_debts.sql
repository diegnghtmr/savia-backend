begin;

alter table public.subscriptions
  add column version integer not null default 1 check (version > 0),
  add column recurring_rule_id uuid,
  add constraint subscriptions_recurring_rule_key unique (workspace_id, recurring_rule_id),
  add constraint subscriptions_recurring_rule_workspace_fkey
    foreign key (workspace_id, recurring_rule_id)
    references public.recurring_rules (workspace_id, id),
  add constraint subscriptions_recurring_rule_status_check
    check (recurring_rule_id is null or status in ('confirmed', 'cancelled'));

grant update (recurring_rule_id) on public.subscriptions to savia_application;

-- Detection may change the terms between list and confirmation. Version those
-- changes too without widening the detector's column-level privileges.
create function public.bump_subscription_version()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger subscriptions_bump_version
before update on public.subscriptions
for each row execute function public.bump_subscription_version();

alter table public.accounts
  drop constraint accounts_type_check,
  add constraint accounts_type_check check (type in (
    'cash', 'savings', 'checking', 'digital_wallet', 'credit_card', 'loan',
    'investment_manual', 'receivable', 'generic', 'informal_debt'
  )),
  add column informal_counterparty_name text,
  add column informal_direction text,
  add constraint accounts_informal_debt_check check (
    (informal_counterparty_name is null and informal_direction is null)
    or (type = 'informal_debt'
        and informal_counterparty_name is not null
        and char_length(btrim(informal_counterparty_name)) between 1 and 120
        and informal_direction is not null
        and informal_direction in ('i_owe', 'owed_to_me'))
  );

grant insert (informal_counterparty_name, informal_direction),
      update (informal_counterparty_name, informal_direction)
  on public.accounts to savia_application;

-- This also exists on the MCP grant branch; retain its value when both land.
alter table public.workspaces
  add column if not exists timezone text not null default 'UTC';

alter table public.debts
  add column payment_frequency text check (
    payment_frequency in ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')
  );

commit;
