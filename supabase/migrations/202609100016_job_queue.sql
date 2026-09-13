begin;

-- Epica 8 / S1: Supabase Queues with pgmq 1.5.1 and transactional outbox.
-- ADR-0020: Asynchronous jobs through Supabase Queues with a least-privilege worker.

-- 1. pgmq extension and queue creation
create extension if not exists pgmq;
select pgmq.create('savia_jobs');

-- 2. Worker role (nologin, nobypassrls, no table grants)
do $$
begin
  if not exists (select from pg_roles where rolname = 'savia_worker') then
    create role savia_worker
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      nobypassrls;
  end if;
end
$$;
grant savia_worker to postgres;
grant usage on schema public to savia_worker;

-- 3. Revoke pgmq from public and grant only to savia_elevated
revoke all on schema pgmq from public;
revoke all on all tables in schema pgmq from public;
revoke all on all functions in schema pgmq from public;
revoke all on all sequences in schema pgmq from public;

grant usage on schema pgmq to savia_elevated;
grant all on all tables in schema pgmq to savia_elevated;
grant execute on all functions in schema pgmq to savia_elevated;
grant all on all sequences in schema pgmq to savia_elevated;

-- 4. Extend jobs table: payload (frozen input + asOf) and attempt_count (default 0)
alter table public.jobs
  add column if not exists payload jsonb;

alter table public.jobs
  add column if not exists attempt_count integer not null default 0
    constraint jobs_attempt_count_check check (attempt_count >= 0);

alter table public.jobs
  add column if not exists queue_message_id bigint
    constraint jobs_queue_message_id_key unique;

-- Legality trigger: enforce legal status moves; terminal rows never change
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
    if new.status not in ('queued', 'processing', 'failed') then
      raise exception 'Illegal status transition from queued to % for job %', new.status, old.id;
    end if;
  elsif old.status = 'processing' then
    if new.status not in ('processing', 'completed', 'failed') then
      raise exception 'Illegal status transition from processing to % for job %', new.status, old.id;
    end if;
  else
    raise exception 'Unexpected initial status % for job %', old.status, old.id;
  end if;

  return new;
end;
$$;

create trigger enforce_job_status_transition
  before update on public.jobs
  for each row
  execute function public.enforce_job_status_transition();

-- 5. Grants and policies on public.jobs
-- Request role keeps only what it had before S1 plus insert of payload and attempt_count
grant insert (payload, attempt_count) on public.jobs to savia_application;

-- Column-scoped grants and policies for savia_elevated
grant select (id, workspace_id, created_by, status, queue_message_id, started_at, attempt_count) on public.jobs to savia_elevated;
grant update (status, started_at, completed_at, error, queue_message_id, attempt_count, progress_percent, result_resource_id) on public.jobs to savia_elevated;

create policy jobs_elevated_select
  on public.jobs
  for select
  to savia_elevated
  using (true);

create policy jobs_elevated_update
  on public.jobs
  for update
  to savia_elevated
  using (true)
  with check (true);

-- 6. Security definer wrappers
-- enqueue_job (granted to savia_application)
create or replace function public.enqueue_job(p_job_id uuid)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_subject uuid;
  v_workspace_id uuid;
  v_created_by uuid;
  v_status text;
  v_queue_message_id bigint;
  v_msg_id bigint;
begin
  v_subject := nullif(current_setting('app.subject_id', true), '')::uuid;
  if v_subject is null then
    raise exception 'Missing app.subject_id context';
  end if;

  select j.workspace_id, j.created_by, j.status, j.queue_message_id
    into v_workspace_id, v_created_by, v_status, v_queue_message_id
    from public.jobs j
   where j.id = p_job_id
     for update;

  if not found then
    raise exception 'Job % not found', p_job_id;
  end if;

  if v_status <> 'queued' then
    raise exception 'Only queued jobs can be enqueued, current status: %', v_status;
  end if;

  if v_created_by <> v_subject then
    raise exception 'Cannot enqueue job created by another subject';
  end if;

  if public.workspace_actor_active_role(v_workspace_id) not in ('owner', 'administrator', 'editor') then
    raise exception 'Caller lacks active write role in job workspace';
  end if;

  if v_queue_message_id is not null then
    return v_queue_message_id;
  end if;

  v_msg_id := pgmq.send(
    'savia_jobs',
    jsonb_build_object(
      'job_id', p_job_id,
      'workspace_id', v_workspace_id
    )
  );

  update public.jobs
     set queue_message_id = v_msg_id
   where id = p_job_id;

  return v_msg_id;
end;
$$;

-- claim_jobs (granted to savia_worker)
create or replace function public.claim_jobs(p_vt integer, p_limit integer)
returns table (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select msg_id, read_ct, enqueued_at, vt, message
    from pgmq.read('savia_jobs', p_vt, p_limit);
$$;

-- ack_job (granted to savia_worker)
create or replace function public.ack_job(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
as $$
  select pgmq.delete('savia_jobs', p_msg_id);
$$;

-- archive_job (granted to savia_worker)
create or replace function public.archive_job(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
as $$
  select pgmq.archive('savia_jobs', p_msg_id);
$$;

-- defer_job (granted to savia_worker)
create or replace function public.defer_job(p_msg_id bigint, p_vt_offset integer)
returns table (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select msg_id, read_ct, enqueued_at, vt, message
    from pgmq.set_vt('savia_jobs', p_msg_id, p_vt_offset);
$$;

-- fail_orphaned_job (granted to savia_worker)
create or replace function public.fail_orphaned_job(p_job_id uuid, p_actor_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_updated integer;
begin
  update public.jobs
     set status = 'failed',
         started_at = coalesce(started_at, clock_timestamp()),
         completed_at = clock_timestamp(),
         error = jsonb_build_object(
           'type', 'https://savia.app/problems/forbidden',
           'title', 'Forbidden',
           'status', 403,
           'code', 'forbidden',
           'traceId', gen_random_uuid()::text
         )
   where id = p_job_id
     and created_by = p_actor_id
     and status in ('queued', 'processing');

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- start_job (granted to savia_worker)
create or replace function public.start_job(p_job_id uuid, p_attempt integer default null)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
  v_started_at timestamptz;
  v_attempt_count integer;
begin
  select status, started_at, attempt_count
    into v_status, v_started_at, v_attempt_count
    from public.jobs
   where id = p_job_id
     for update;

  if not found then
    raise exception 'Job % not found', p_job_id;
  end if;

  if v_status not in ('queued', 'processing') then
    raise exception 'Cannot start job %: expected status queued or processing, got %', p_job_id, v_status;
  end if;

  update public.jobs
     set status = 'processing',
         started_at = coalesce(v_started_at, clock_timestamp()),
         attempt_count = coalesce(p_attempt, v_attempt_count + 1)
   where id = p_job_id;

  return true;
end;
$$;

-- complete_job (granted to savia_worker)
create or replace function public.complete_job(p_job_id uuid, p_result_resource_id uuid default null)
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

  if v_status <> 'processing' then
    raise exception 'Cannot complete job %: expected status processing, got %', p_job_id, v_status;
  end if;

  update public.jobs
     set status = 'completed',
         progress_percent = 100,
         completed_at = clock_timestamp(),
         result_resource_id = p_result_resource_id
   where id = p_job_id;

  return true;
end;
$$;

-- fail_job (granted to savia_worker)
create or replace function public.fail_job(p_job_id uuid, p_error jsonb)
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

  if v_status <> 'processing' then
    raise exception 'Cannot fail job %: expected status processing, got %', p_job_id, v_status;
  end if;

  if p_error is null then
    raise exception 'Cannot fail job % without an error', p_job_id;
  end if;

  update public.jobs
     set status = 'failed',
         completed_at = clock_timestamp(),
         error = p_error
   where id = p_job_id;

  return true;
end;
$$;

-- 7. Revoke EXECUTE from public, grant to roles
revoke all on function public.enqueue_job(uuid) from public;
revoke all on function public.claim_jobs(integer, integer) from public;
revoke all on function public.ack_job(bigint) from public;
revoke all on function public.archive_job(bigint) from public;
revoke all on function public.defer_job(bigint, integer) from public;
revoke all on function public.fail_orphaned_job(uuid, uuid) from public;
revoke all on function public.start_job(uuid, integer) from public;
revoke all on function public.complete_job(uuid, uuid) from public;
revoke all on function public.fail_job(uuid, jsonb) from public;
revoke all on function public.enforce_job_status_transition() from public;

grant execute on function public.enqueue_job(uuid) to savia_application;
grant execute on function public.claim_jobs(integer, integer) to savia_worker;
grant execute on function public.ack_job(bigint) to savia_worker;
grant execute on function public.archive_job(bigint) to savia_worker;
grant execute on function public.defer_job(bigint, integer) to savia_worker;
grant execute on function public.fail_orphaned_job(uuid, uuid) to savia_worker;
grant execute on function public.start_job(uuid, integer) to savia_worker;
grant execute on function public.complete_job(uuid, uuid) to savia_worker;
grant execute on function public.fail_job(uuid, jsonb) to savia_worker;

-- 8. Ownership to savia_elevated (RULING 13 pattern)
grant usage, create on schema public to savia_elevated;

alter function public.enqueue_job(uuid) owner to savia_elevated;
alter function public.claim_jobs(integer, integer) owner to savia_elevated;
alter function public.ack_job(bigint) owner to savia_elevated;
alter function public.archive_job(bigint) owner to savia_elevated;
alter function public.defer_job(bigint, integer) owner to savia_elevated;
alter function public.fail_orphaned_job(uuid, uuid) owner to savia_elevated;
alter function public.start_job(uuid, integer) owner to savia_elevated;
alter function public.complete_job(uuid, uuid) owner to savia_elevated;
alter function public.fail_job(uuid, jsonb) owner to savia_elevated;
alter function public.enforce_job_status_transition() owner to savia_elevated;

revoke create on schema public from savia_elevated;

commit;
