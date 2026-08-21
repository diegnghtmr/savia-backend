begin;
drop policy application_reads_member_workspace on public.workspaces;
create policy application_reads_member_workspace
  on public.workspaces
  for select
  to savia_application
  using (
    personal_owner_profile_id = nullif(
      current_setting('app.subject_id', true), ''
    )::uuid
    or exists (
      select 1
      from public.workspace_memberships membership
      where membership.workspace_id = workspaces.id
        and membership.profile_id = nullif(
          current_setting('app.subject_id', true), ''
        )::uuid
        and membership.status = 'active'
    )
  );
commit;
