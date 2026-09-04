begin;

-- Epica 6 slice 5: debts.
create table public.debts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  name text not null,
  currency text not null,
  principal_minor bigint not null,
  annual_rate numeric not null,
  rate_type text not null,
  minimum_payment_minor bigint,
  start_date date,
  term_months integer,
  next_payment_at date,
  status text not null default 'active',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint debts_workspace_id_id_key unique (workspace_id, id),
  constraint debts_name_length_check check (char_length(name) between 1 and 120),
  constraint debts_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint debts_principal_minor_positive_check check (principal_minor > 0),
  constraint debts_annual_rate_non_negative_check check (annual_rate >= 0),
  constraint debts_rate_type_check check (rate_type in ('fixed', 'variable')),
  constraint debts_status_check check (status in ('active', 'paid', 'defaulted', 'archived')),
  constraint debts_term_months_check check (term_months is null or term_months >= 1),
  constraint debts_minimum_payment_minor_check check (minimum_payment_minor is null or minimum_payment_minor >= 0),
  constraint debts_version_check check (version >= 1),
  constraint debts_workspace_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade
);

create index debts_workspace_created_at_id_idx on public.debts (workspace_id, created_at asc, id asc);

create table public.debt_payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  debt_id uuid not null,
  transaction_id uuid not null,
  principal_minor bigint not null,
  interest_minor bigint not null,
  fee_minor bigint not null,
  created_at timestamptz not null default now(),
  constraint debt_payments_workspace_id_id_key unique (workspace_id, id),
  constraint debt_payments_workspace_transaction_key unique (workspace_id, transaction_id),
  constraint debt_payments_workspace_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint debt_payments_debt_workspace_fkey foreign key (workspace_id, debt_id) references public.debts(workspace_id, id) on delete cascade,
  constraint debt_payments_transaction_workspace_fkey foreign key (workspace_id, transaction_id) references public.transactions(workspace_id, id) on delete restrict,
  constraint debt_payments_principal_minor_non_negative_check check (principal_minor >= 0),
  constraint debt_payments_interest_minor_non_negative_check check (interest_minor >= 0),
  constraint debt_payments_fee_minor_non_negative_check check (fee_minor >= 0),
  constraint debt_payments_total_positive_check check (principal_minor + interest_minor + fee_minor > 0)
);

create index debt_payments_workspace_debt_id_idx on public.debt_payments (workspace_id, debt_id);
create index debt_payments_workspace_transaction_id_idx on public.debt_payments (workspace_id, transaction_id);

comment on table public.debts is 'Debts. fitness:financial';
comment on table public.debt_payments is 'Debt payment split links. fitness:financial';

alter table public.debts enable row level security;
alter table public.debts force row level security;
alter table public.debt_payments enable row level security;
alter table public.debt_payments force row level security;

grant select on public.debts to savia_application;
grant insert (workspace_id, id, name, currency, principal_minor, annual_rate, rate_type, minimum_payment_minor, start_date, term_months, next_payment_at, status, version) on public.debts to savia_application;

grant select on public.debt_payments to savia_application;
grant insert (workspace_id, id, debt_id, transaction_id, principal_minor, interest_minor, fee_minor, created_at) on public.debt_payments to savia_application;

create policy application_reads_workspace_debts on public.debts
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_debts on public.debts
  for insert to savia_application
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'));

create policy application_reads_workspace_debt_payments on public.debt_payments
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_debt_payments on public.debt_payments
  for insert to savia_application
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'));

commit;
