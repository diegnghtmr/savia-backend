begin;

-- Architectural Decisions (Slice 5.4)
-- RULING 85: export jobs and their object paths are workspace scoped.
-- RULING 86: expires_at records the exact signed URL expiry.
-- RULING 87: signing credentials are runtime configuration, never database data.
-- RULING 88: csv, json_backup, and xlsx are all supported.
-- RULING 89: unsupported declared resources are explicit 422 outcomes.
-- RULING 90: resourceId and date ranges are validated by the command boundary.
-- RULING 91: source reads reuse the existing account and transaction derivations.

create table public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  format text not null constraint export_jobs_format_check check (format in ('csv', 'json_backup', 'xlsx')),
  resource text not null constraint export_jobs_resource_check check (resource in ('all', 'transactions', 'accounts', 'budgets', 'debts', 'report')),
  resource_id uuid,
  from_date date,
  to_date date,
  status text not null constraint export_jobs_status_check check (status in ('queued', 'processing', 'completed', 'failed')),
  object_path text,
  download_url text,
  expires_at timestamptz,
  error jsonb,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint export_jobs_workspace_id_id_key unique (workspace_id, id),
  constraint export_jobs_terminal_fields_check check (
    (status = 'completed' and completed_at is not null and object_path is not null and download_url is not null and expires_at is not null and error is null)
    or (status = 'failed' and completed_at is not null and error is not null and object_path is null and download_url is null and expires_at is null)
    or (status in ('queued', 'processing') and completed_at is null and error is null)
  ),
  constraint export_jobs_error_problem_details_shape_check check (
    error is null or (
      jsonb_typeof(error) = 'object' and error ? 'type' and error ? 'title' and error ? 'status' and error ? 'code' and error ? 'traceId'
      and jsonb_typeof(error->'type') = 'string' and jsonb_typeof(error->'title') = 'string'
      and jsonb_typeof(error->'code') = 'string' and jsonb_typeof(error->'traceId') = 'string'
      and jsonb_typeof(error->'status') = 'number' and (error->>'status') ~ '^[1-5][0-9]{2}$'
    )
  )
);

create index export_jobs_workspace_created_at_idx on public.export_jobs (workspace_id, created_at, id);
alter table public.export_jobs enable row level security;
alter table public.export_jobs force row level security;
grant select on public.export_jobs to savia_application;
grant insert (id, workspace_id, format, resource, resource_id, from_date, to_date, status, object_path, download_url, expires_at, error, created_by, completed_at) on public.export_jobs to savia_application;

create policy application_reads_workspace_export_jobs on public.export_jobs for select to savia_application using (
  public.workspace_actor_active_role(export_jobs.workspace_id) in ('owner', 'administrator', 'editor', 'viewer')
);
create policy application_inserts_workspace_export_jobs on public.export_jobs for insert to savia_application with check (
  public.workspace_actor_active_role(export_jobs.workspace_id) in ('owner', 'administrator', 'editor')
  and export_jobs.created_by = nullif(current_setting('app.subject_id', true), '')::uuid
);
commit;
