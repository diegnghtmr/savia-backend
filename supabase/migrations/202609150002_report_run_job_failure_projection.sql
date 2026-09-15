begin;

-- S5b: admit report_run on jobs, and project job failed/dead_letter onto the
-- linked report run in the same transaction. dead_letter is not a ReportRun
-- status; copy the job error onto failed.

alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in (
    'import_commit',
    'import_rollback',
    'balance_forecast',
    'report_run'
  ));


grant select on public.report_runs to savia_elevated;
grant update (status, error, completed_at) on public.report_runs to savia_elevated;

create policy elevated_reads_report_runs on public.report_runs
  for select to savia_elevated
  using (true);

create policy elevated_updates_report_runs on public.report_runs
  for update to savia_elevated
  using (true)
  with check (status = 'failed');

create or replace function public.project_report_run_job_failure()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('failed', 'dead_letter') then
    update public.report_runs
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

revoke all on function public.project_report_run_job_failure() from public;

grant usage, create on schema public to savia_elevated;
alter function public.project_report_run_job_failure() owner to savia_elevated;
revoke create on schema public from savia_elevated;

create trigger project_report_run_job_failure
  after update of status on public.jobs
  for each row
  when (new.status in ('failed', 'dead_letter'))
  execute function public.project_report_run_job_failure();

commit;
