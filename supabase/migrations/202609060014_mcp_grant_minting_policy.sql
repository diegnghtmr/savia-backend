begin;

create function public.mcp_scope_allowed_for_role(scope text, minter_role text)
returns boolean
language sql
immutable
strict
as $$
  select case minter_role
    when 'owner' then scope in (
      'accounts:read', 'accounts:write', 'budgets:read', 'budgets:write',
      'reports:read', 'reports:write', 'transactions:read',
      'transactions:write', 'workspace:admin'
    )
    when 'administrator' then scope in (
      'accounts:read', 'accounts:write', 'budgets:read', 'budgets:write',
      'reports:read', 'reports:write', 'transactions:read',
      'transactions:write', 'workspace:admin'
    )
    when 'editor' then scope in (
      'accounts:read', 'accounts:write', 'budgets:read', 'budgets:write',
      'reports:read', 'reports:write', 'transactions:read',
      'transactions:write'
    )
    when 'viewer' then scope in (
      'accounts:read', 'budgets:read', 'reports:read', 'transactions:read'
    )
    else false
  end;
$$;

create function public.mcp_grant_within_minter_role(
  scopes text[],
  workspace_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select cardinality(scopes) > 0
    and cardinality(workspace_ids) > 0
    and not exists (
      select 1
      from unnest(workspace_ids) as requested(workspace_id)
      cross join lateral (
        select public.workspace_actor_active_role(requested.workspace_id) as role
      ) membership
      where membership.role is null
         or exists (
           select 1
           from unnest(scopes) as requested_scope(scope)
           where not public.mcp_scope_allowed_for_role(
             requested_scope.scope,
             membership.role
           )
         )
    );
$$;

create function public.mcp_grant_accounts_within_workspaces(
  account_ids uuid[],
  workspace_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(cardinality(workspace_ids), 0) > 0
    and not exists (
      select 1
      from unnest(workspace_ids) as requested(workspace_id)
      where public.workspace_actor_active_role(requested.workspace_id) is null
    )
    and (
      account_ids is null
      or cardinality(account_ids) = 0
      or not exists (
        select 1
        from unnest(account_ids) as requested(account_id)
        where not exists (
          select 1
          from public.accounts account
          where account.id = requested.account_id
            and account.workspace_id = any(workspace_ids)
        )
      )
    );
$$;

grant usage, create on schema public to savia_elevated;

alter function public.mcp_scope_allowed_for_role(text, text)
  owner to savia_elevated;
alter function public.mcp_grant_within_minter_role(text[], uuid[])
  owner to savia_elevated;
alter function public.mcp_grant_accounts_within_workspaces(uuid[], uuid[])
  owner to savia_elevated;

revoke create on schema public from savia_elevated;
revoke all on function public.mcp_scope_allowed_for_role(text, text) from public;
revoke all on function public.mcp_grant_within_minter_role(text[], uuid[]) from public;
revoke all on function public.mcp_grant_accounts_within_workspaces(uuid[], uuid[]) from public;
grant execute on function public.mcp_grant_within_minter_role(text[], uuid[])
  to savia_application;
grant execute on function public.mcp_grant_accounts_within_workspaces(uuid[], uuid[])
  to savia_application;

do $$
declare
  violating_count bigint;
  grant_row record;
begin
  violating_count := 0;
  for grant_row in
    select subject_id, scopes, workspace_ids, account_ids
      from public.mcp_grants
     where status = 'active'
       and (expires_at is null or expires_at > now())
  loop
    perform set_config('app.subject_id', grant_row.subject_id::text, true);
    if not public.mcp_grant_within_minter_role(grant_row.scopes, grant_row.workspace_ids)
       or not public.mcp_grant_accounts_within_workspaces(
         grant_row.account_ids,
         grant_row.workspace_ids
       ) then
      violating_count := violating_count + 1;
    end if;
  end loop;
  perform set_config('app.subject_id', '', true);

  if violating_count > 0 then
    raise exception
      'mcp grant minting policy refused to install: % active unexpired grant(s) exceed the current minter role; revoke offending grants before retrying',
      violating_count;
  end if;
end;
$$;

drop policy mcp_grants_insert_own on public.mcp_grants;
create policy mcp_grants_insert_own
  on public.mcp_grants
  for insert
  to savia_application
  with check (
    subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and public.mcp_grant_within_minter_role(scopes, workspace_ids)
    and public.mcp_grant_accounts_within_workspaces(account_ids, workspace_ids)
  );

commit;
