begin;

-- Separate the immutable execution snapshot from the public preview.
alter table public.approvals
  add column mcp_grant_id uuid references public.mcp_grants(id),
  add column mcp_arguments jsonb,
  add constraint approvals_mcp_snapshot_check check (
    (mcp_grant_id is null and mcp_arguments is null)
    or (channel is not distinct from 'mcp' and mcp_grant_id is not null
        and mcp_arguments is not null and jsonb_typeof(mcp_arguments) = 'object')
  );
grant insert (mcp_grant_id, mcp_arguments) on public.approvals to savia_application;

-- Preserve administrator decisions for legacy unbound rows and rejections.
-- Bound proposals, like agent actions, can be confirmed only by the creator.
alter policy application_updates_workspace_approvals on public.approvals
  using (
    status = 'pending' and (
      public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator')
      or ((channel = 'agent' or mcp_grant_id is not null)
          and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
          and public.workspace_actor_active_role(workspace_id) = 'editor')
    )
  )
  with check (
    (
      (status = 'rejected' or (status = 'approved' and channel is distinct from 'agent' and mcp_grant_id is null))
      and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator')
    ) or (
      status = 'approved' and (channel = 'agent' or mcp_grant_id is not null)
      and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
      and decided_by = created_by
      and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    )
  );

commit;
