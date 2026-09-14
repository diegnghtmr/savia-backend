begin;

-- Epica 8 / S3: Retry with backoff, dead letter, and job_transitions audit.
-- ADR-0020: Invariant change for dead_letter, audit trail via security-definer trigger.

-- 1. Invariant change: dead_letter carries an RFC 9457 Problem Details error
alter table public.jobs drop constraint jobs_error_only_when_failed_check;
alter table public.jobs add constraint jobs_error_only_when_failed_or_dead_letter_check
  check ((status in ('failed', 'dead_letter') and error is not null)
      or (status not in ('failed', 'dead_letter') and error is null));

-- 2. Security definer wrapper: dead_letter_job (granted to savia_worker)
create or replace function public.dead_letter_job(p_job_id uuid, p_error jsonb)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
begin
  select status
    into v_status
    from public.jobs
   where id = p_job_id
     for update;

  if not found then
    raise exception 'Job % not found', p_job_id;
  end if;

  if v_status not in ('queued', 'processing') then
    raise exception 'Cannot dead letter job %: expected status queued or processing, got %', p_job_id, v_status;
  end if;

  if p_error is null then
    raise exception 'Cannot dead letter job % without an error', p_job_id;
  end if;

  update public.jobs
     set status = 'dead_letter',
         started_at = coalesce(started_at, clock_timestamp()),
         completed_at = clock_timestamp(),
         error = p_error
   where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.dead_letter_job(uuid, jsonb) from public;
grant execute on function public.dead_letter_job(uuid, jsonb) to savia_worker;

grant usage, create on schema public to savia_elevated;
alter function public.dead_letter_job(uuid, jsonb) owner to savia_elevated;
revoke create on schema public from savia_elevated;

-- 3. Extend enforce_job_status_transition to allow transitions to dead_letter
create or replace function public.enforce_job_status_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Terminal rows never change
  if old.status in ('completed', 'failed', 'cancelled', 'dead_letter') then
    raise exception 'Terminal job % with status % cannot be modified', old.id, old.status;
  end if;

  -- Immutable columns
  if new.id <> old.id
     or new.workspace_id <> old.workspace_id
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at
     or new.type <> old.type
     or new.payload is distinct from old.payload then
    raise exception 'Immutable job columns cannot be updated on job %', old.id;
  end if;

  -- Legal status moves
  if old.status = 'queued' then
    if new.status not in ('queued', 'processing', 'failed', 'dead_letter') then
      raise exception 'Illegal status transition from queued to % for job %', new.status, old.id;
    end if;
  elsif old.status = 'processing' then
    if new.status not in ('processing', 'completed', 'failed', 'dead_letter') then
      raise exception 'Illegal status transition from processing to % for job %', new.status, old.id;
    end if;
  else
    raise exception 'Unexpected initial status % for job %', old.status, old.id;
  end if;

  return new;
end;
$$;

-- 4. Audit table: public.job_transitions
create table public.job_transitions (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  job_id uuid not null,
  from_status text,
  to_status text not null,
  attempt integer not null constraint job_transitions_attempt_check check (attempt >= 0),
  error jsonb,
  occurred_at timestamptz not null,
  constraint job_transitions_job_fkey foreign key (workspace_id, job_id)
    references public.jobs (workspace_id, id) on delete cascade,
  constraint job_transitions_status_check check (
    (from_status is null or from_status in ('queued', 'processing', 'completed', 'failed', 'cancelled', 'dead_letter'))
    and to_status in ('queued', 'processing', 'completed', 'failed', 'cancelled', 'dead_letter')
  ),
  constraint job_transitions_error_check check (
    (to_status in ('failed', 'dead_letter') and error is not null)
    or (to_status not in ('failed', 'dead_letter') and error is null)
  ),
  constraint job_transitions_error_problem_details_shape_check check (
    error is null
    or (
      jsonb_typeof(error) = 'object'
      and error ? 'type'
      and error ? 'title'
      and error ? 'status'
      and error ? 'code'
      and error ? 'traceId'
      and jsonb_typeof(error->'type') = 'string'
      and jsonb_typeof(error->'title') = 'string'
      and jsonb_typeof(error->'code') = 'string'
      and jsonb_typeof(error->'traceId') = 'string'
      and jsonb_typeof(error->'status') = 'number'
      and (error->>'status') ~ '^[1-5][0-9]{2}$'
    )
  )
);

create index job_transitions_workspace_job_idx
  on public.job_transitions (workspace_id, job_id, id);

alter table public.job_transitions enable row level security;
alter table public.job_transitions force row level security;

-- Grants: savia_application gets SELECT only, savia_worker nothing, savia_elevated INSERT only
grant select on public.job_transitions to savia_application;
grant insert on public.job_transitions to savia_elevated;

create policy application_reads_workspace_job_transitions
  on public.job_transitions
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(job_transitions.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy elevated_inserts_job_transitions
  on public.job_transitions
  for insert
  to savia_elevated
  with check (true);

-- 5. Trigger function and triggers on public.jobs
create or replace function public.record_job_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.job_transitions (
    workspace_id,
    job_id,
    from_status,
    to_status,
    attempt,
    error,
    occurred_at
  ) values (
    new.workspace_id,
    new.id,
    case when TG_OP = 'INSERT' then null else old.status end,
    new.status,
    new.attempt_count,
    new.error,
    clock_timestamp()
  );
  return new;
end;
$$;

revoke all on function public.record_job_transition() from public;

grant usage, create on schema public to savia_elevated;
alter function public.record_job_transition() owner to savia_elevated;
revoke create on schema public from savia_elevated;

create trigger record_job_transition_on_insert
  after insert on public.jobs
  for each row
  execute function public.record_job_transition();

create trigger record_job_transition_on_update
  after update of status, attempt_count on public.jobs
  for each row
  when (old.status is distinct from new.status or old.attempt_count is distinct from new.attempt_count)
  execute function public.record_job_transition();

-- 6. Backfill one transition row per existing job
insert into public.job_transitions (
  workspace_id,
  job_id,
  from_status,
  to_status,
  attempt,
  error,
  occurred_at
)
select
  j.workspace_id,
  j.id,
  null,
  j.status,
  j.attempt_count,
  j.error,
  coalesce(j.completed_at, j.started_at, j.created_at)
  from public.jobs j;

commit;
