begin;

-- RULING 106: imported transaction headers retain their import provenance.
alter table public.transactions add column import_job_id uuid;
do $$
begin
  if exists (
    select 1
      from public.transactions t
      left join public.import_jobs j
        on j.workspace_id = t.workspace_id and j.id = t.import_job_id
     where t.import_job_id is not null and j.id is null
  ) then
    raise exception 'transactions.import_job_id contains an orphan before traceability constraint';
  end if;
end;
$$;

grant select on public.import_job_rows to savia_application;

alter table public.transactions add constraint transactions_import_job_workspace_fkey
  foreign key (workspace_id, import_job_id)
  references public.import_jobs (workspace_id, id);
create index transactions_import_job_idx
  on public.transactions (workspace_id, import_job_id)
  where import_job_id is not null;
grant update (import_job_id) on public.transactions to savia_application;
grant insert (import_job_id) on public.transactions to savia_application;

-- The mapping is checked against the headers captured during analysis.
alter table public.import_jobs add column source_columns text[];
grant update (account_id, status, completed_at) on public.import_jobs to savia_application;
grant insert (source_columns) on public.import_jobs to savia_application;
create policy application_updates_import_jobs
  on public.import_jobs for update to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor'))
  with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor'));

commit;
