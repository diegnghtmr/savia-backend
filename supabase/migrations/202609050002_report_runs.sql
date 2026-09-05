begin;

-- Epica 8 slice 2a: report runs schema, constraints, and RLS.
create table public.report_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  definition_id uuid,
  preset text,
  status text not null constraint report_runs_status_check check (status in ('queued', 'processing', 'completed', 'failed')),
  format text not null constraint report_runs_format_check check (format in ('json', 'csv', 'pdf')),
  snapshot_id uuid,
  object_path text,
  download_url text,
  expires_at timestamptz,
  filters jsonb not null default '{}'::jsonb,
  error jsonb,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint report_runs_workspace_id_id_key unique (workspace_id, id),
  constraint report_runs_preset_check check (
    preset is null or preset in (
      'monthly_summary',
      'cash_flow',
      'expenses',
      'income',
      'budget',
      'net_worth',
      'debts',
      'funds',
      'family_workspace',
      'multi_currency',
      'forecast',
      'period_comparison'
    )
  ),
  constraint report_runs_definition_xor_preset_check check (
    (definition_id is not null and preset is null)
    or (definition_id is null and preset is not null)
  ),
  constraint report_runs_filters_is_object_check check (jsonb_typeof(filters) = 'object'),
  constraint report_runs_definition_workspace_fkey foreign key (workspace_id, definition_id)
    references public.report_definitions (workspace_id, id) on delete cascade,
  constraint report_runs_completed_at_terminal_check check (
    (status in ('completed', 'failed') and completed_at is not null)
    or (status not in ('completed', 'failed') and completed_at is null)
  )
);

create index report_runs_workspace_created_at_id_idx
  on public.report_runs (workspace_id, created_at asc, id asc);

alter table public.report_runs enable row level security;
alter table public.report_runs force row level security;

grant select on public.report_runs to savia_application;
grant insert (
  id,
  workspace_id,
  definition_id,
  preset,
  status,
  format,
  snapshot_id,
  object_path,
  download_url,
  expires_at,
  filters,
  error,
  created_by,
  completed_at
) on public.report_runs to savia_application;

create policy application_reads_workspace_report_runs on public.report_runs
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_report_runs on public.report_runs
  for insert to savia_application
  with check (
    public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  );

commit;
