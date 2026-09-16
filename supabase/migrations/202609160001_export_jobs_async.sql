begin;

-- S6: export_jobs job linkage, snapshot identity, and non-terminal updates.
-- Recreates application_updates_workspace_export_jobs so WITH CHECK admits processing.
-- Follows S5b failure projection: copies job failed/dead_letter onto export_jobs as failed.

alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in (
    'import_commit',
    'import_rollback',
    'balance_forecast',
    'report_run',
    'export_job'
  ));

alter table public.export_jobs
  add column job_id uuid;

do $$
begin
  if exists (
    select 1
      from public.export_jobs e
      left join public.jobs j
        on j.workspace_id = e.workspace_id and j.id = e.job_id
     where e.job_id is not null and j.id is null
  ) then
    raise exception 'export_jobs.job_id contains an orphan before linkage constraint';
  end if;
end;
$$;

alter table public.export_jobs
  add constraint export_jobs_job_workspace_fkey
    foreign key (workspace_id, job_id)
    references public.jobs (workspace_id, id);

create index export_jobs_workspace_job_idx
  on public.export_jobs (workspace_id, job_id)
  where job_id is not null;

grant insert (job_id) on public.export_jobs to savia_application;

drop policy application_updates_workspace_export_jobs on public.export_jobs;

create policy application_updates_workspace_export_jobs on public.export_jobs
  for update to savia_application
  using (
    public.workspace_actor_active_role(export_jobs.workspace_id)
      in ('owner', 'administrator', 'editor')
    and export_jobs.status in ('queued', 'processing')
  )
  with check (
    public.workspace_actor_active_role(export_jobs.workspace_id)
      in ('owner', 'administrator', 'editor')
    and export_jobs.status in ('queued', 'processing', 'completed', 'failed')
  );

grant select on public.export_jobs to savia_elevated;
grant update (status, error, completed_at) on public.export_jobs to savia_elevated;

create policy elevated_reads_export_jobs on public.export_jobs
  for select to savia_elevated
  using (true);

create policy elevated_updates_export_jobs on public.export_jobs
  for update to savia_elevated
  using (true)
  with check (status = 'failed');

create or replace function public.project_export_job_failure()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('failed', 'dead_letter') then
    update public.export_jobs
       set status = 'failed',
           error = new.error,
           completed_at = clock_timestamp()
     where workspace_id = new.workspace_id
       and job_id = new.id
       and status in ('queued', 'processing');
  end if;
  return new;
end;
$$;

revoke all on function public.project_export_job_failure() from public;

grant usage, create on schema public to savia_elevated;
alter function public.project_export_job_failure() owner to savia_elevated;
revoke create on schema public from savia_elevated;

create trigger project_export_job_failure
  after update of status on public.jobs
  for each row
  when (new.status in ('failed', 'dead_letter'))
  execute function public.project_export_job_failure();

commit;
