begin;

-- Epica 7 slice 3c: extend jobs_type_check to allow balance_forecast, and public.forecasts table.

-- 1. Extend jobs_type_check
alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in ('import_commit', 'import_rollback', 'balance_forecast'));

-- 2. public.forecasts
create table public.forecasts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  job_id uuid not null,
  status text not null,
  confidence text not null,
  method text not null,
  horizon_days integer not null,
  assumptions jsonb not null default '[]'::jsonb,
  series jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint forecasts_workspace_id_id_key unique (workspace_id, id),
  constraint forecasts_status_check check (status in ('queued', 'processing', 'completed', 'failed')),
  constraint forecasts_confidence_check check (confidence in ('low', 'medium', 'high')),
  constraint forecasts_horizon_days_range_check check (horizon_days between 1 and 730),
  constraint forecasts_assumptions_is_array_check check (jsonb_typeof(assumptions) = 'array'),
  constraint forecasts_series_is_array_check check (jsonb_typeof(series) = 'array'),
  constraint forecasts_job_workspace_fkey
    foreign key (workspace_id, job_id) references public.jobs (workspace_id, id) on delete cascade
);

create index forecasts_workspace_created_at_id_idx
  on public.forecasts (workspace_id, created_at asc, id asc);

create index forecasts_created_by_idx
  on public.forecasts (created_by);

comment on table public.forecasts is 'Workspace balance forecasts. fitness:financial';

alter table public.forecasts enable row level security;
alter table public.forecasts force row level security;

grant select on public.forecasts to savia_application;
grant insert (
  id,
  workspace_id,
  job_id,
  status,
  confidence,
  method,
  horizon_days,
  assumptions,
  series,
  generated_at,
  created_by
) on public.forecasts to savia_application;

create policy application_reads_workspace_forecasts on public.forecasts
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_forecasts on public.forecasts
  for insert to savia_application
  with check (
    public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  );

commit;
