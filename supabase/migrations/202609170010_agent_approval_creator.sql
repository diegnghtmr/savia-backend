begin;

alter policy application_updates_workspace_approvals on public.approvals
  using (
    status = 'pending' and (
      public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator')
      or (channel = 'agent'
          and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
          and public.workspace_actor_active_role(workspace_id) = 'editor')
    )
  )
  with check (
    (
      (status = 'rejected' or (status = 'approved' and channel is distinct from 'agent'))
      and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator')
    ) or (
      status = 'approved' and channel = 'agent'
      and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
      and decided_by = created_by
      and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    )
  );

commit;
