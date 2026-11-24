begin;

-- An active member can reject their own pending approval. Keep confirmation
-- permissions unchanged for both legacy and creator-bound approvals.
alter policy application_updates_workspace_approvals on public.approvals
  using (
    status = 'pending' and (
      public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator')
      or (created_by = nullif(current_setting('app.subject_id', true), '')::uuid
          and public.workspace_actor_active_role(workspace_id) in ('editor', 'viewer'))
    )
  )
  with check (
    (
      status = 'rejected'
      and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
      and decided_by = created_by
      and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer')
    ) or (
      status = 'approved' and channel is distinct from 'agent' and mcp_grant_id is null
      and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator')
    ) or (
      status = 'approved' and (channel = 'agent' or mcp_grant_id is not null)
      and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
      and decided_by = created_by
      and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    )
  );

commit;
