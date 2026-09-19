begin;

-- S5a: report_runs job linkage, snapshot identity, and non-terminal updates.
-- snapshot_id remains the frozen snapshot identity (job id once S5b enqueues).

alter table public.report_runs
  add column job_id uuid;

do $$
begin
  if exists (
    select 1
      from public.report_runs r
      left join public.jobs j
        on j.workspace_id = r.workspace_id and j.id = r.job_id
     where r.job_id is not null and j.id is null
  ) then
    raise exception 'report_runs.job_id contains an orphan before linkage constraint';
  end if;
end;
$$;

alter table public.report_runs
  add constraint report_runs_job_workspace_fkey
    foreign key (workspace_id, job_id)
    references public.jobs (workspace_id, id);

create index report_runs_workspace_job_idx
  on public.report_runs (workspace_id, job_id)
  where job_id is not null;

grant insert (job_id) on public.report_runs to savia_application;

grant update (
  status,
  snapshot_id,
  object_path,
  download_url,
  expires_at,
  error,
  completed_at
) on public.report_runs to savia_application;

create policy application_updates_workspace_report_runs on public.report_runs
  for update to savia_application
  using (
    public.workspace_actor_active_role(workspace_id)
      in ('owner', 'administrator', 'editor')
    and status in ('queued', 'processing')
  )
  with check (
    public.workspace_actor_active_role(workspace_id)
      in ('owner', 'administrator', 'editor')
    and status in ('queued', 'processing', 'completed', 'failed')
  );

commit;
