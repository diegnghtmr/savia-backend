begin;

-- Replaces public.enqueue_job(p_job_id uuid) to include actor_id in the pgmq envelope.
-- create or replace preserves existing ownership (savia_elevated) and execute grants (savia_application only).
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
      'workspace_id', v_workspace_id,
      'actor_id', v_created_by
    )
  );

  update public.jobs
     set queue_message_id = v_msg_id
   where id = p_job_id;

  return v_msg_id;
end;
$$;

commit;
