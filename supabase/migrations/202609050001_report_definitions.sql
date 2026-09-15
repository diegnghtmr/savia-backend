begin;

-- Epica 8 slice 1: report definitions create and list.
create table public.report_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  dimensions jsonb not null,
  measures jsonb not null,
  visualization text not null,
  filters jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint report_definitions_workspace_id_id_key unique (workspace_id, id),
  constraint report_definitions_name_length_check check (char_length(name) between 1 and 120),
  constraint report_definitions_visualization_check
    check (visualization in ('table', 'kpi', 'bar', 'line', 'area', 'donut', 'heatmap', 'calendar', 'pivot')),
  constraint report_definitions_version_check check (version >= 1),
  constraint report_definitions_dimensions_is_array_check check (jsonb_typeof(dimensions) = 'array'),
  constraint report_definitions_measures_is_array_check check (jsonb_typeof(measures) = 'array'),
  constraint report_definitions_measures_non_empty_check check (jsonb_array_length(measures) >= 1),
  constraint report_definitions_filters_is_object_check check (jsonb_typeof(filters) = 'object')
);

create index report_definitions_workspace_created_at_id_idx
  on public.report_definitions (workspace_id, created_at asc, id asc);

alter table public.report_definitions enable row level security;
alter table public.report_definitions force row level security;

grant select on public.report_definitions to savia_application;
grant insert (workspace_id, name, dimensions, measures, visualization, filters, version, created_by) on public.report_definitions to savia_application;

create policy application_reads_workspace_report_definitions on public.report_definitions
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_report_definitions on public.report_definitions
  for insert to savia_application
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor') and created_by = nullif(current_setting('app.subject_id', true), '')::uuid);

commit;
