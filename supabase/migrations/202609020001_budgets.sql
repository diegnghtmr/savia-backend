begin;
-- Epica 6 slice 1: budgets.
-- RULING 115: currency is snapshotted from workspaces at creation.
-- RULING 116: allocations are real child rows and are empty until populated.
-- RULING 117: strict period and 366-day inclusive boundary.
-- RULING 118: overlapping periods are allowed; no period uniqueness constraint.
-- RULING 119: copied rows contain plan only, never computed outcomes.
-- RULING 120: database owns version, starting at one.
create table public.budgets (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
  name text not null, method text not null, period_start date not null, period_end date not null,
  currency text not null, version integer not null default 1, created_by uuid not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint budgets_workspace_id_id_key unique (workspace_id,id),
  constraint budgets_method_check check (method in ('cash_flow','zero_based','envelope','hybrid')),
  constraint budgets_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint budgets_name_length_check check (char_length(name) between 1 and 120),
  constraint budgets_period_order_check check (period_end > period_start),
  constraint budgets_period_span_check check (period_end - period_start <= 366),
  constraint budgets_version_check check (version >= 1),
  foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  foreign key (created_by) references public.profiles(id) on delete restrict
);
create index budgets_workspace_period_id_idx on public.budgets (workspace_id,period_start desc,id desc);
create table public.budget_allocations (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, budget_id uuid not null,
  category_id uuid not null, planned_minor bigint not null, rollover_policy text not null default 'none',
  rollover_target_id uuid, created_at timestamptz not null default now(),
  constraint budget_allocations_rollover_policy_check check (rollover_policy in ('none','surplus','deficit','both','to_savings','to_fund','to_category')),
  constraint budget_allocations_budget_workspace_fkey foreign key (workspace_id,budget_id) references public.budgets(workspace_id,id) on delete cascade,
  constraint budget_allocations_category_workspace_fkey foreign key (workspace_id,category_id) references public.categories(workspace_id,id) on delete restrict,
  constraint budget_allocations_workspace_budget_category_key unique (workspace_id,budget_id,category_id)
);
alter table public.budgets enable row level security; alter table public.budgets force row level security;
alter table public.budget_allocations enable row level security; alter table public.budget_allocations force row level security;
grant select on public.budgets to savia_application;
grant insert (workspace_id,name,method,period_start,period_end,currency,version,created_by) on public.budgets to savia_application;
grant select on public.budget_allocations to savia_application;
grant insert (workspace_id,budget_id,category_id,planned_minor,rollover_policy,rollover_target_id) on public.budget_allocations to savia_application;
create policy application_reads_workspace_budgets on public.budgets for select to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer'));
create policy application_inserts_workspace_budgets on public.budgets for insert to savia_application with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor') and created_by = nullif(current_setting('app.subject_id',true),'')::uuid);
create policy application_reads_workspace_budget_allocations on public.budget_allocations for select to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer'));
create policy application_inserts_workspace_budget_allocations on public.budget_allocations for insert to savia_application with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor'));
commit;
