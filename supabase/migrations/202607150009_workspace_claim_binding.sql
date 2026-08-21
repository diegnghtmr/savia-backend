begin;

grant create on schema public to savia_elevated;

-- The creator cannot SELECT their own ownerless collaborative workspace: the read
-- policy requires an active membership, which does not exist yet. So this check
-- cannot be written inline in the policy for the same reason the original helper
-- exists -- it would be RLS-blind. Binding the claim to `created_by` also removes the
-- previous helper's existence-oracle: it now answers only for workspaces the caller
-- created.
create function public.collaborative_workspace_is_claimable_by(
  target_workspace_id uuid,
  claimant_profile_id uuid
)
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
             and workspace.created_by = claimant_profile_id
         )
     and not exists (
           select 1
           from public.workspace_memberships membership
           where membership.workspace_id = target_workspace_id
         );
$$;

alter function public.collaborative_workspace_is_claimable_by(uuid, uuid)
  owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke execute on function public.collaborative_workspace_is_claimable_by(uuid, uuid) from public;
grant execute on function public.collaborative_workspace_is_claimable_by(uuid, uuid)
  to savia_application;

drop policy application_inserts_collaborative_owner_membership on public.workspace_memberships;
create policy application_inserts_collaborative_owner_membership
  on public.workspace_memberships
  for insert
  to savia_application
  with check (
    profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and role = 'owner'
    and status = 'active'
    and public.collaborative_workspace_is_claimable_by(
          workspace_memberships.workspace_id,
          nullif(current_setting('app.subject_id', true), '')::uuid
        )
  );

-- The creator must stamp themselves; a forged created_by is refused here.
drop policy application_inserts_collaborative_workspace on public.workspaces;
create policy application_inserts_collaborative_workspace
  on public.workspaces
  for insert
  to savia_application
  with check (
    kind in ('family', 'shared')
    and personal_owner_profile_id is null
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  );

drop function public.collaborative_workspace_is_unclaimed(uuid);

commit;
