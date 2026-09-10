begin;

-- Epica 6 slice 4: sinking funds.
create table public.funds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  name text not null,
  currency text not null,
  target_amount_minor bigint not null,
  target_date date,
  linked_account_id uuid,
  status text not null default 'active',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funds_workspace_id_id_key unique (workspace_id, id),
  constraint funds_name_length_check check (char_length(name) between 1 and 120),
  constraint funds_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint funds_target_amount_minor_check check (target_amount_minor > 0),
  constraint funds_status_check check (status in ('active', 'completed', 'paused', 'archived')),
  constraint funds_version_check check (version >= 1),
  constraint funds_workspace_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint funds_linked_account_workspace_fkey foreign key (workspace_id, linked_account_id) references public.accounts(workspace_id, id) on delete restrict
);

create index funds_workspace_created_at_id_idx on public.funds (workspace_id, created_at asc, id asc);

create table public.fund_contributions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  fund_id uuid not null,
  transaction_id uuid not null,
  created_at timestamptz not null default now(),
  constraint fund_contributions_workspace_id_id_key unique (workspace_id, id),
  constraint fund_contributions_workspace_transaction_key unique (workspace_id, transaction_id),
  constraint fund_contributions_workspace_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint fund_contributions_fund_workspace_fkey foreign key (workspace_id, fund_id) references public.funds(workspace_id, id) on delete cascade,
  constraint fund_contributions_transaction_workspace_fkey foreign key (workspace_id, transaction_id) references public.transactions(workspace_id, id) on delete restrict
);

create index fund_contributions_workspace_fund_id_idx on public.fund_contributions (workspace_id, fund_id);
create index fund_contributions_workspace_transaction_id_idx on public.fund_contributions (workspace_id, transaction_id);

comment on table public.funds is 'Sinking funds. fitness:financial';
comment on table public.fund_contributions is 'Sinking fund contribution links. fitness:financial';

alter table public.funds enable row level security;
alter table public.funds force row level security;
alter table public.fund_contributions enable row level security;
alter table public.fund_contributions force row level security;

grant select on public.funds to savia_application;
grant insert (workspace_id, id, name, currency, target_amount_minor, target_date, linked_account_id, status, version) on public.funds to savia_application;

grant select on public.fund_contributions to savia_application;
grant insert (workspace_id, id, fund_id, transaction_id, created_at) on public.fund_contributions to savia_application;

create policy application_reads_workspace_funds on public.funds
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_funds on public.funds
  for insert to savia_application
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'));

create policy application_reads_workspace_fund_contributions on public.fund_contributions
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_fund_contributions on public.fund_contributions
  for insert to savia_application
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'));

commit;
