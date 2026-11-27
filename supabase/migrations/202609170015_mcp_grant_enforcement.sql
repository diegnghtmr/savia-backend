begin;

-- Keep legacy grants read-only, without imposing an unexpected time restriction.
-- The workspace time zone is internal until a later workspace contract change.
alter table public.workspaces add column timezone text not null default 'UTC';
alter table public.mcp_grants
  add column tool_allowlist text[] not null default '{}',
  add column schedule jsonb not null default '[
    {"dayOfWeek":1,"startTime":"00:00","endTime":"24:00"},
    {"dayOfWeek":2,"startTime":"00:00","endTime":"24:00"},
    {"dayOfWeek":3,"startTime":"00:00","endTime":"24:00"},
    {"dayOfWeek":4,"startTime":"00:00","endTime":"24:00"},
    {"dayOfWeek":5,"startTime":"00:00","endTime":"24:00"},
    {"dayOfWeek":6,"startTime":"00:00","endTime":"24:00"},
    {"dayOfWeek":7,"startTime":"00:00","endTime":"24:00"}
  ]'::jsonb,
  add constraint mcp_grants_tool_allowlist_unique_check check (public.mcp_array_is_unique(tool_allowlist)),
  add constraint mcp_grants_schedule_array_check check (jsonb_typeof(schedule) = 'array');
-- Changing the default does not change the value materialized for legacy rows.
alter table public.mcp_grants alter column schedule set default '[]'::jsonb;

grant insert (tool_allowlist, schedule) on public.mcp_grants to savia_application;

grant select (id, subject_id, scopes, workspace_ids, account_ids, tool_allowlist,
  schedule, max_write_amount_minor, max_write_currency, status, expires_at),
  update (status) on public.mcp_grants to savia_elevated;
create policy elevated_reads_actor_mcp_grants on public.mcp_grants
  for select to savia_elevated
  using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);
create policy elevated_locks_actor_mcp_grants on public.mcp_grants
  for update to savia_elevated
  using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid)
  with check (false);

grant update (timezone) on public.workspaces to savia_elevated;
create policy elevated_locks_mcp_workspace_timezone on public.workspaces
  for update to savia_elevated using (true) with check (false);

-- Lock only; no privilege to mutate grants, membership or timezone. Share
-- locks survive function return and conflict with revocation and role changes.
create function public.locked_mcp_grant_policy(
  expected_subject uuid, target_grant uuid, target_workspace uuid,
  required_scopes text[], affected_accounts uuid[]
) returns table (
  role text, tool_allowlist text[], schedule jsonb,
  max_write_amount_minor text, max_write_currency text,
  local_day integer, local_time text
)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := nullif(current_setting('app.subject_id', true), '')::uuid;
  actor_role text;
  workspace_zone text;
  grant_policy record;
  call_time timestamptz;
  workspace_time timestamp;
begin
  if actor is null or actor is distinct from expected_subject
     or required_scopes is null or affected_accounts is null then
    return;
  end if;

  select m.role into actor_role from public.workspace_memberships m
    where m.workspace_id = target_workspace and m.profile_id = actor and m.status = 'active'
    for share;
  if not found then return; end if;

  select w.timezone into workspace_zone from public.workspaces w
    where w.id = target_workspace for share;
  if not found then return; end if;

  select g.status, g.expires_at, g.workspace_ids, g.scopes, g.account_ids,
         g.tool_allowlist, g.schedule, g.max_write_amount_minor, g.max_write_currency
    into grant_policy from public.mcp_grants g
    where g.id = target_grant and g.subject_id = actor for share;
  if not found or grant_policy.status <> 'active'
     or not (target_workspace = any(grant_policy.workspace_ids))
     or not (required_scopes <@ grant_policy.scopes)
     or exists (
       select 1 from unnest(required_scopes) as required(scope)
       where public.mcp_scope_allowed_for_role(required.scope, actor_role) is not true
     ) then return; end if;

  if coalesce(cardinality(grant_policy.account_ids), 0) > 0
     and (cardinality(affected_accounts) = 0 or not (affected_accounts <@ grant_policy.account_ids)) then
    return;
  end if;
  if cardinality(affected_accounts) <> (
    select count(*) from public.accounts a
      where a.workspace_id = target_workspace and a.id = any(affected_accounts)
  ) then return; end if;

  -- Do not accept POSIX offsets, host aliases or unresolved names. Evaluate the
  -- wall clock only after acquiring all locks; waiting must not extend a grant.
  if workspace_zone in ('localtime', 'posixrules')
     or workspace_zone like 'posix/%' or workspace_zone like 'right/%'
     or not exists (select 1 from pg_timezone_names z where z.name = workspace_zone) then
    return;
  end if;
  call_time := clock_timestamp();
  if grant_policy.expires_at is not null and grant_policy.expires_at <= call_time then
    return;
  end if;
  workspace_time := timezone(workspace_zone, call_time);
  return query select actor_role, grant_policy.tool_allowlist, grant_policy.schedule,
    grant_policy.max_write_amount_minor::text, grant_policy.max_write_currency::text,
    extract(isodow from workspace_time)::integer, to_char(workspace_time, 'HH24:MI');
end;
$$;

grant usage, create on schema public to savia_elevated;
alter function public.locked_mcp_grant_policy(uuid, uuid, uuid, text[], uuid[]) owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke all on function public.locked_mcp_grant_policy(uuid, uuid, uuid, text[], uuid[]) from public;
grant execute on function public.locked_mcp_grant_policy(uuid, uuid, uuid, text[], uuid[]) to savia_application;

commit;
