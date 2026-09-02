begin;
-- RULING 97 / RULING 103: rejected analysis uploads return 422 and create no job;
-- failed is reserved for post-creation failures in Slice 5.6.
create table public.import_jobs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  file_name text not null, status text not null constraint import_jobs_status_check check (status in ('uploaded','analyzing','awaiting_mapping','awaiting_confirmation','processing','completed','failed','rolled_back')),
  account_id uuid, detected_format text constraint import_jobs_format_check check (detected_format is null or detected_format in ('csv','xlsx','qif','ofx','qfx')),
  total_rows integer, valid_rows integer, duplicate_rows integer, error_rows integer, error jsonb,
  created_by uuid not null references public.profiles(id) on delete restrict, created_at timestamptz not null default now(), completed_at timestamptz,
  constraint import_jobs_workspace_id_id_key unique (workspace_id,id),
  constraint import_jobs_counts_check check (total_rows is null or (total_rows >= 0 and valid_rows >= 0 and duplicate_rows >= 0 and error_rows >= 0 and total_rows = valid_rows + duplicate_rows + error_rows)),
  constraint import_jobs_error_problem_details_shape_check check (error is null or (jsonb_typeof(error)='object' and error ? 'type' and error ? 'title' and error ? 'status' and error ? 'code' and error ? 'traceId' and jsonb_typeof(error->'type')='string' and jsonb_typeof(error->'title')='string' and jsonb_typeof(error->'status')='number' and jsonb_typeof(error->'code')='string' and jsonb_typeof(error->'traceId')='string' and (error->>'status') ~ '^[1-5][0-9]{2}$'))
);
create table public.import_job_rows (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, import_job_id uuid not null, row_number integer not null check (row_number > 1), raw_values jsonb not null,
  parsed_date date, parsed_amount_minor bigint, parsed_description text, classification text not null constraint import_job_rows_classification_check check (classification in ('valid','duplicate','error')), error jsonb,
  created_at timestamptz not null default now(),
  constraint import_job_rows_workspace_id_id_key unique (workspace_id,id), constraint import_job_rows_parent_fk foreign key (workspace_id,import_job_id) references public.import_jobs(workspace_id,id) on delete cascade,
  constraint import_job_rows_error_check check ((classification='error' and error is not null) or (classification in ('valid','duplicate') and error is null))
);
create index import_job_rows_parent_idx on public.import_job_rows(workspace_id,import_job_id,row_number);
alter table public.import_jobs enable row level security; alter table public.import_jobs force row level security;
alter table public.import_job_rows enable row level security; alter table public.import_job_rows force row level security;
grant select on public.import_jobs to savia_application; grant insert (id,workspace_id,file_name,status,account_id,detected_format,total_rows,valid_rows,duplicate_rows,error_rows,error,created_by,created_at,completed_at) on public.import_jobs to savia_application;
grant insert (id,workspace_id,import_job_id,row_number,raw_values,parsed_date,parsed_amount_minor,parsed_description,classification,error) on public.import_job_rows to savia_application;
create policy application_reads_import_jobs on public.import_jobs for select to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer'));
create policy application_inserts_import_jobs on public.import_jobs for insert to savia_application with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor') and created_by = nullif(current_setting('app.subject_id',true),'')::uuid);
create policy application_reads_import_job_rows on public.import_job_rows for select to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer'));
create policy application_inserts_import_job_rows on public.import_job_rows for insert to savia_application with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor'));
commit;
