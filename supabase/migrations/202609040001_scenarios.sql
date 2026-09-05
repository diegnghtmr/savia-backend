begin;

-- Epica 7 slice 3a: scenarios create and list.
create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  assumptions jsonb not null,
  last_run_id uuid,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint scenarios_workspace_id_id_key unique (workspace_id, id),
  constraint scenarios_name_length_check check (char_length(name) between 1 and 120),
  constraint scenarios_description_length_check
    check (description is null or char_length(description) <= 1000),
  constraint scenarios_assumptions_is_array_check check (jsonb_typeof(assumptions) = 'array'),
  constraint scenarios_assumptions_non_empty_check check (jsonb_array_length(assumptions) >= 1)
);

create index scenarios_workspace_created_at_id_idx
  on public.scenarios (workspace_id, created_at asc, id asc);

alter table public.scenarios enable row level security;
alter table public.scenarios force row level security;

grant select on public.scenarios to savia_application;
grant insert (workspace_id, name, description, assumptions, created_by) on public.scenarios to savia_application;

create policy application_reads_workspace_scenarios on public.scenarios
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_scenarios on public.scenarios
  for insert to savia_application
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor') and created_by = nullif(current_setting('app.subject_id', true), '')::uuid);

commit;
