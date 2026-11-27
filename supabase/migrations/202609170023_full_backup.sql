begin;

alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check check (type in (
  'import_commit', 'import_rollback', 'balance_forecast', 'report_run',
  'export_job', 'receipt_ocr', 'workspace_backup'
));

-- Constrain only the new kind. Worker/elevated policies and legacy jobs are unchanged.
create policy application_backup_jobs_owner_insert on public.jobs
  as restrictive for insert to savia_application with check (
    type <> 'workspace_backup' or public.workspace_actor_active_role(workspace_id) = 'owner'
  );
create policy application_backup_jobs_requester_read on public.jobs
  as restrictive for select to savia_application using (
    type <> 'workspace_backup' or (
      public.workspace_actor_active_role(workspace_id) = 'owner'
      and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
    )
  );

create table public.workspace_backups (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  job_id uuid not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  download_url text,
  expires_at timestamptz,
  constraint workspace_backups_job_workspace_fkey
    foreign key (workspace_id, job_id) references public.jobs (workspace_id, id) on delete cascade,
  constraint workspace_backups_signature_check check (
    (download_url is null and expires_at is null)
    or (download_url is not null and download_url like 'https://%' and expires_at is not null)
  )
);
create index workspace_backups_workspace_id_idx on public.workspace_backups (workspace_id);
alter table public.workspace_backups enable row level security;
alter table public.workspace_backups force row level security;
grant select on public.workspace_backups to savia_application;
grant insert (id, workspace_id, job_id, created_by) on public.workspace_backups to savia_application;
grant update (download_url, expires_at) on public.workspace_backups to savia_application;

create policy workspace_backups_requester_owner on public.workspace_backups
  for all to savia_application
  using (
    public.workspace_actor_active_role(workspace_id) = 'owner'
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  )
  with check (
    public.workspace_actor_active_role(workspace_id) = 'owner'
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  );

commit;
