begin;

-- Epica 7 slice 3b: scenario_runs table, grants and policies, and scenarios update grant.
create table public.scenario_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scenario_id uuid not null,
  status text not null,
  baseline jsonb not null,
  projected jsonb not null,
  difference jsonb not null,
  risks jsonb not null default '[]'::jsonb,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint scenario_runs_workspace_id_id_key unique (workspace_id, id),
  constraint scenario_runs_status_check check (status in ('completed', 'failed')),
  constraint scenario_runs_risks_is_array_check check (jsonb_typeof(risks) = 'array'),
  constraint scenario_runs_scenario_workspace_fkey
    foreign key (workspace_id, scenario_id)
    references public.scenarios (workspace_id, id) on delete cascade
);

create index scenario_runs_workspace_scenario_id_created_at_idx
  on public.scenario_runs (workspace_id, scenario_id, created_at asc);

alter table public.scenario_runs enable row level security;
alter table public.scenario_runs force row level security;

grant select on public.scenario_runs to savia_application;
grant insert (workspace_id, scenario_id, status, baseline, projected, difference, risks, created_by)
  on public.scenario_runs to savia_application;

create policy application_reads_workspace_scenario_runs on public.scenario_runs
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_scenario_runs on public.scenario_runs
  for insert to savia_application
  with check (
    public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  );

-- Update grant and policy on public.scenarios for last_run_id
grant update (last_run_id) on public.scenarios to savia_application;

create policy application_updates_workspace_scenarios on public.scenarios
  for update to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'))
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'));

commit;
