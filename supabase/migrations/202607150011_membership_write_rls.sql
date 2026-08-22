begin;
alter table public.workspace_memberships add column version integer;
update public.workspace_memberships set version = 1 where version is null;
set constraints all immediate;
alter table public.workspace_memberships alter column version set default 1;
alter table public.workspace_memberships alter column version set not null;
alter table public.workspace_memberships
  add constraint workspace_memberships_version_gte_1 check (version >= 1);

-- Column-scoped, per 202607150009:80-83 and 202607150010:24-28. A table-wide grant
-- would let a write path re-point workspace_id or profile_id and seize a membership.
-- The column list is the load-bearing part (spec Requirement D).
grant update (role, status, version) on public.workspace_memberships to savia_application;
grant delete on public.workspace_memberships to savia_application;  -- no column form; the restriction lives in `using`

grant usage, create on schema public to savia_elevated;   -- revoked below (RULING 13)

-- A policy on workspace_memberships CANNOT subquery workspace_memberships: PostgreSQL
-- raises 42P17 `infinite recursion detected in policy for relation` at plan time
-- (executed, #4227 FINDING 1). Hence this helper.
-- The subject is read HERE and is NOT a parameter. C4's collaborative_workspace_is_claimable_by
-- takes a claimant parameter safely only because a policy WITH CHECK binds it; a function the
-- adapter calls directly has no such binding and a parameter would be forgeable (#4227 FINDING 6).
-- Returns NULL when the caller is not an active member, so every comparison against it is NULL
-- and the policy fails closed.
create function public.workspace_actor_active_role(target_workspace_id uuid)
returns text
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select membership.role
  from public.workspace_memberships membership
  where membership.workspace_id = target_workspace_id
    and membership.profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and membership.status = 'active';
$$;
alter function public.workspace_actor_active_role(uuid) owner to savia_elevated;
revoke create on schema public from savia_elevated;   -- immediately (RULING 13; a permanent grant was the C4 defect)
revoke execute on function public.workspace_actor_active_role(uuid) from public;
grant execute on function public.workspace_actor_active_role(uuid) to savia_application;

-- Read visibility for the WRITE path, not the roster. Slices 3 and 4 issue a confirming
-- re-read after a zero-row UPDATE/DELETE to separate a policy refusal from a concurrent
-- deletion; without visibility of the target member's row that re-read always answers
-- "absent" and every refusal collapses into a 404.
-- RLS policies for one command are OR'd, so this composes with
-- application_reads_own_membership (202607150002:39-44) rather than replacing it.
-- It calls the security-definer helper instead of subquerying workspace_memberships,
-- because a policy that references its own table raises 42P17 `infinite recursion
-- detected in policy for relation` at query time (executed).
-- No `kind in ('family','shared')` guard here, deliberately: a personal workspace's sole
-- member is the caller, already visible through application_reads_own_membership, so the
-- guard would be unreachable. This project does not ship security controls no test can
-- exercise. The write policies below DO carry the guard because there it is reachable.
create policy application_reads_administered_membership
  on public.workspace_memberships for select to savia_application
  using (
    public.workspace_actor_active_role(workspace_memberships.workspace_id)
      in ('owner','administrator')
  );

-- `kind in ('family','shared')`, never `kind <> 'personal'`, so a future kind fails
-- closed (202607150009:105-106).
create policy application_updates_administered_membership
  on public.workspace_memberships for update to savia_application
  using (
    exists (select 1 from public.workspaces workspace
            where workspace.id = workspace_memberships.workspace_id
              and workspace.kind in ('family','shared'))
    and public.workspace_actor_active_role(workspace_memberships.workspace_id)
          in ('owner','administrator')
    and (workspace_memberships.role <> 'owner'
         or public.workspace_actor_active_role(workspace_memberships.workspace_id) = 'owner')
  )
  with check (
    -- `using` reads `role`, which the statement mutates, so `with check` earns its keep
    -- here (202607150010:42-46). An administrator may never mint an owner (RULING 3/7).
    -- DELIBERATE: this `with check` does NOT repeat the `kind in ('family','shared')` guard.
    -- It cannot reference the OLD row, so it can never prevent a re-point of workspace_id or
    -- profile_id. The COLUMN-SCOPED `grant update (role, status, version)` above is the SOLE
    -- defence against membership seizure, and Sabotage B proves it. Widening that grant to a
    -- table-wide `grant update` silently re-opens seizure; do not widen it. A `kind` guard added
    -- here would be unreachable in the shipped configuration, and this project does not ship
    -- security controls no test can exercise.
    workspace_memberships.role in ('owner','administrator','editor','viewer')
    and (workspace_memberships.role <> 'owner'
         or public.workspace_actor_active_role(workspace_memberships.workspace_id) = 'owner')
  );

create policy application_deletes_administered_membership
  on public.workspace_memberships for delete to savia_application
  using (
    exists (select 1 from public.workspaces workspace
            where workspace.id = workspace_memberships.workspace_id
              and workspace.kind in ('family','shared'))
    and public.workspace_actor_active_role(workspace_memberships.workspace_id)
          in ('owner','administrator')
    and (workspace_memberships.role <> 'owner'
         or public.workspace_actor_active_role(workspace_memberships.workspace_id) = 'owner')
  );
commit;
