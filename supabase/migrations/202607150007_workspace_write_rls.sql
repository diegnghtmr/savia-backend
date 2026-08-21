begin;

-- All three identity tables carry `force row level security`, so a policy's
-- inline subquery over another table is filtered by that table's own policies.
-- At the moment the creator inserts their owner membership no membership exists
-- yet, and an inline `not exists` over OTHER users' memberships is blind, which
-- turns the anti-escalation guard into a no-op. Hence one narrow security-definer
-- predicate owned by savia_elevated (a nobypassrls role created unused in
-- 202607150002:9-15, which postgres is already a member of).
-- `create` is granted here only for the `alter function ... owner to` below and is
-- revoked immediately after the ownership transfer.
grant usage, create on schema public to savia_elevated;
grant select on public.workspaces, public.workspace_memberships to savia_elevated;

create policy elevated_reads_workspaces
  on public.workspaces
  for select
  to savia_elevated
  using (true);

create policy elevated_reads_memberships
  on public.workspace_memberships
  for select
  to savia_elevated
  using (true);

create function public.collaborative_workspace_is_unclaimed(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
           select 1
           from public.workspaces workspace
           where workspace.id = target_workspace_id
             and workspace.kind in ('family', 'shared')
         )
     and not exists (
           select 1
           from public.workspace_memberships membership
           where membership.workspace_id = target_workspace_id
         );
$$;

alter function public.collaborative_workspace_is_unclaimed(uuid)
  owner to savia_elevated;

-- `create` was needed only for the ownership transfer above. Revoke it now so
-- savia_elevated keeps exactly two capabilities: reading the two tables its
-- security-definer predicate needs, and owning that predicate.
revoke create on schema public from savia_elevated;
revoke execute on function public.collaborative_workspace_is_unclaimed(uuid) from public;
grant execute on function public.collaborative_workspace_is_unclaimed(uuid)
  to savia_application;

-- Blocker 1. INSERT policies have only `with check`; there is no `using` to write.
create policy application_inserts_collaborative_workspace
  on public.workspaces
  for insert
  to savia_application
  with check (
    kind in ('family', 'shared')
    and personal_owner_profile_id is null
  );

-- Blocker 2.
create policy application_inserts_collaborative_owner_membership
  on public.workspace_memberships
  for insert
  to savia_application
  with check (
    profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and role = 'owner'
    and status = 'active'
    and public.collaborative_workspace_is_unclaimed(workspace_memberships.workspace_id)
  );

-- Blocker 3. Column-scoped, per the 202607150005 precedent. A table-wide grant
-- would let this policy flip `kind` to 'personal' and seize another profile's
-- unique personal-workspace slot. The column list is the load-bearing part.
grant update (name, base_currency, version) on public.workspaces to savia_application;

-- No `with check`: PostgreSQL applies `using` as the check when none is declared,
-- and this predicate reads only membership, which the statement does not mutate.
create policy application_updates_administered_workspace
  on public.workspaces
  for update
  to savia_application
  using (
    exists (
      select 1
      from public.workspace_memberships membership
      where membership.workspace_id = workspaces.id
        and membership.profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
        and membership.status = 'active'
        and membership.role in ('owner', 'administrator')
    )
  );

-- Blocker 4. `grant delete` has no column form; the restriction lives in `using`.
grant delete on public.workspaces to savia_application;

-- `kind in ('family','shared')` rather than `kind <> 'personal'` so a future kind
-- value fails closed.
create policy application_deletes_owned_collaborative_workspace
  on public.workspaces
  for delete
  to savia_application
  using (
    workspaces.kind in ('family', 'shared')
    and exists (
      select 1
      from public.workspace_memberships membership
      where membership.workspace_id = workspaces.id
        and membership.profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
        and membership.status = 'active'
        and membership.role = 'owner'
    )
  );

commit;
