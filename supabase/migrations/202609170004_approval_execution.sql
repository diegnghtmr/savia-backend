begin;

alter table public.approvals
  add column channel text check (channel in ('agent', 'mcp')),
  add column used_at timestamptz,
  drop constraint approvals_decided_state_check,
  add constraint approvals_decided_state_check check (
    (status in ('approved', 'rejected', 'consumed') and decided_at is not null and decided_by is not null)
    or
    (status not in ('approved', 'rejected') and decided_at is null and decided_by is null)
  ),
  add constraint approvals_used_state_check check (
    used_at is null or (status = 'consumed' and decided_at is not null)
  );

grant insert (workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by, channel)
  on public.approvals to savia_application;
create policy application_inserts_workspace_approvals on public.approvals
  for insert to savia_application with check (
    status = 'pending' and channel is not null
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
    and (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator')
         or (risk_class <> 'administrative' and public.workspace_actor_active_role(workspace_id) = 'editor'))
  );

alter policy application_updates_workspace_approvals on public.approvals
  using (status = 'pending' and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator'))
  with check (status in ('approved', 'rejected') and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator'));

grant select (id, workspace_id, tool_name, risk_class, arguments_hash, status, expires_at, created_by, used_at),
      update (status, used_at) on public.approvals to savia_elevated;
create policy elevated_reads_actor_approvals on public.approvals
  for select to savia_elevated
  using (
    workspace_id = nullif(current_setting('app.approval_workspace_id', true), '')::uuid
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  );
create policy elevated_consumes_actor_approvals on public.approvals
  for update to savia_elevated
  using (
    workspace_id = nullif(current_setting('app.approval_workspace_id', true), '')::uuid
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
    and status = 'approved'
  ) with check (
    workspace_id = nullif(current_setting('app.approval_workspace_id', true), '')::uuid
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
    and status = 'consumed' and used_at is not null
  );

create function public.claim_approval(target_workspace uuid, target_approval uuid, target_tool text, target_hash text)
returns text language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := nullif(current_setting('app.subject_id', true), '')::uuid;
  prior_workspace text := current_setting('app.approval_workspace_id', true);
  actor_role text;
  claimed boolean;
begin
  -- Hold the current authorization through the action's transaction, using
  -- the existing elevated membership row-lock policy.
  select role into actor_role from public.workspace_memberships
   where workspace_id = target_workspace and profile_id = actor and status = 'active'
     for share;
  if actor_role is null or actor_role not in ('owner', 'administrator', 'editor') then
    return 'forbidden';
  end if;

  perform set_config('app.approval_workspace_id', target_workspace::text, true);

  -- An UPDATE can qualify a row before waiting on its lock. Lock first so
  -- the expiry predicate is evaluated after any wait, even on an unchanged row.
  perform 1 from public.approvals
   where id = target_approval and workspace_id = target_workspace and created_by = actor
     for update;
  if found then
    update public.approvals set status = 'consumed', used_at = clock_timestamp()
     where id = target_approval and workspace_id = target_workspace and created_by = actor
       and tool_name = target_tool and arguments_hash = target_hash
       and status = 'approved' and expires_at > clock_timestamp()
       and (actor_role <> 'editor' or risk_class <> 'administrative');
  end if;
  claimed := found;
  -- On error, PostgreSQL rolls the transaction-local setting back with the statement.
  perform set_config('app.approval_workspace_id', coalesce(prior_workspace, ''), true);
  return case when claimed then 'ok' else 'conflict' end;
end;
$$;

grant usage, create on schema public to savia_elevated;
alter function public.claim_approval(uuid, uuid, text, text) owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke execute on function public.claim_approval(uuid, uuid, text, text) from public;
grant execute on function public.claim_approval(uuid, uuid, text, text) to savia_application;

commit;
