begin;

-- Epica 5 slice 1: public.jobs table.
--
-- RULING 64: No background worker exists in this epic. jobs is a persisted table
-- with a status machine. Later slices will write job rows already in a TERMINAL state
-- inside the request transaction. This slice creates the table and the read path only.
-- Do NOT create a queue, a scheduler, a worker process, a cron entry, or a cancel endpoint.
--
-- RULING 65: jobs.type is constrained in the database with a named CHECK constraint
-- to exactly the two types this epic will produce: 'import_commit' and 'import_rollback'.
--
-- RULING 66: Cross-workspace and unknown ids are indistinguishable. A job that
-- belongs to another workspace MUST answer 404, never 403. RLS makes the row invisible;
-- the adapter finds nothing and the service returns a not-found outcome. 403 is reserved
-- for a caller whose membership in the header workspace is itself insufficient.
--
-- RULING 67: The status machine is enforced by CHECK constraints:
-- - jobs_status_check: status in ('queued','processing','completed','failed','cancelled','dead_letter')
-- - jobs_type_check: type in ('import_commit','import_rollback')
-- - jobs_progress_percent_range_check: progress_percent is null or between 0 and 100
-- - jobs_started_at_required_check: started_at is null when status = 'queued', and NOT NULL otherwise
-- - jobs_completed_at_terminal_check: completed_at is NOT NULL exactly when status is terminal ('completed','failed','cancelled','dead_letter'), and NULL otherwise
-- - jobs_error_only_when_failed_check: error is NOT NULL when status = 'failed' and NULL otherwise
-- - jobs_result_only_when_completed_check: result_resource_id is NULL unless status = 'completed'
--
-- RULING 68: error is stored as jsonb holding an RFC 9457 Problem Details object,
-- and is returned verbatim under the error key. It is never a bare string.
--
-- Architectural Decisions:
-- D1. Workspace-scoped table: public.jobs.
--     Uses `workspace_id uuid not null references public.workspaces(id) on delete cascade`,
--     matching the house convention.
--     Carries `constraint jobs_workspace_id_id_key unique (workspace_id, id)`
--     for future composite foreign keys (RULING 48).
--
-- D2. Status machine and type invariants:
--     Enforces named CHECK constraints for type, status, progress_percent, started_at,
--     completed_at, error, and result_resource_id per RULING 65 and RULING 67.
--
-- D3. Error payload storage:
--     `error jsonb` stores the Problem Details object directly.
--
-- D4. RLS and Grants:
--     Reads permitted for active workspace members (owner, administrator, editor, viewer).
--     Inserts permitted for active owner, administrator, editor bound to `app.subject_id`.
--     Grants to savia_application: select, and COLUMN-SCOPED insert.
--     No update grant and no delete grant in this slice (least privilege).

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type text not null
    constraint jobs_type_check
    check (type in ('import_commit', 'import_rollback')),
  status text not null
    constraint jobs_status_check
    check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled', 'dead_letter')),
  progress_percent integer
    constraint jobs_progress_percent_range_check
    check (progress_percent is null or (progress_percent >= 0 and progress_percent <= 100)),
  result_resource_id uuid,
  error jsonb,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint jobs_workspace_id_id_key
    unique (workspace_id, id),
  constraint jobs_started_at_required_check
    check (
      (status = 'queued' and started_at is null)
      or (status <> 'queued' and started_at is not null)
    ),
  constraint jobs_completed_at_terminal_check
    check (
      (status in ('completed', 'failed', 'cancelled', 'dead_letter') and completed_at is not null)
      or (status not in ('completed', 'failed', 'cancelled', 'dead_letter') and completed_at is null)
    ),
  constraint jobs_error_only_when_failed_check
    check (
      (status = 'failed' and error is not null)
      or (status <> 'failed' and error is null)
    ),
  constraint jobs_result_only_when_completed_check
    check (
      result_resource_id is null or status = 'completed'
    )
);

create index jobs_created_by_idx
  on public.jobs (created_by);

create index jobs_workspace_created_at_idx
  on public.jobs (workspace_id, created_at, id);

comment on table public.jobs is 'Workspace asynchronous jobs. RULING 64: table and read path only. RULING 67: status machine invariants.';

-- Row Level Security
alter table public.jobs enable row level security;
alter table public.jobs force row level security;

-- Grants: COLUMN-SCOPED insert grant for least privilege.
-- workspace_id, created_by, created_at, and id are immutable after insertion.
-- No update and no delete privileges exist in this slice.
grant select on public.jobs to savia_application;
grant insert (
  workspace_id,
  type,
  status,
  progress_percent,
  result_resource_id,
  error,
  created_by,
  started_at,
  completed_at
) on public.jobs to savia_application;

-- Policies routed through public.workspace_actor_active_role helper.
create policy application_reads_workspace_jobs
  on public.jobs
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(jobs.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_jobs
  on public.jobs
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(jobs.workspace_id)
      in ('owner', 'administrator', 'editor')
    and jobs.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

commit;
