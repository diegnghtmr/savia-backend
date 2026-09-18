begin;

-- S1: receipt_ocr job type, receipt job linkage, least-privilege grants, and failure projection trigger.
-- Admits receipt_ocr on jobs, links receipts to jobs via composite FK,
-- and projects job failed/dead_letter onto receipts as failed in the same transaction.

alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check
  check (type in (
    'import_commit',
    'import_rollback',
    'balance_forecast',
    'report_run',
    'export_job',
    'receipt_ocr'
  ));

alter table public.receipts
  add column job_id uuid,
  add column error jsonb;

do $$
begin
  if exists (
    select 1
      from public.receipts r
      left join public.jobs j
        on j.workspace_id = r.workspace_id and j.id = r.job_id
     where r.job_id is not null and j.id is null
  ) then
    raise exception 'receipts.job_id contains an orphan before linkage constraint';
  end if;
end;
$$;

alter table public.receipts
  add constraint receipts_job_workspace_fkey
    foreign key (workspace_id, job_id)
    references public.jobs (workspace_id, id);

create index receipts_workspace_job_idx
  on public.receipts (workspace_id, job_id)
  where job_id is not null;

grant insert (job_id) on public.receipts to savia_application;
grant update (merchant, date, currency, total) on public.receipts to savia_application;

grant select on public.receipts to savia_elevated;
grant update (status, error, updated_at) on public.receipts to savia_elevated;

create policy elevated_reads_receipts on public.receipts
  for select to savia_elevated
  using (true);

create policy elevated_updates_receipts on public.receipts
  for update to savia_elevated
  using (true)
  with check (status = 'failed');

create or replace function public.project_receipt_job_failure()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('failed', 'dead_letter') then
    update public.receipts
       set status = 'failed',
           error = new.error,
           updated_at = clock_timestamp()
     where workspace_id = new.workspace_id
       and job_id = new.id
       and transaction_id is null
       and status in ('uploaded', 'processing');
  end if;
  return new;
end;
$$;

revoke all on function public.project_receipt_job_failure() from public;

grant usage, create on schema public to savia_elevated;
alter function public.project_receipt_job_failure() owner to savia_elevated;
revoke create on schema public from savia_elevated;

create trigger project_receipt_job_failure
  after update of status on public.jobs
  for each row
  when (new.status in ('failed', 'dead_letter'))
  execute function public.project_receipt_job_failure();

commit;
