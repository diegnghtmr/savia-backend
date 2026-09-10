begin;

-- Epica 6 slice 2: budgets update grant and RLS policy.
-- Least privilege: only name, method, version, and updated_at may be updated.
-- Id, workspace_id, period_start, period_end, currency, created_by, created_at are immutable.
grant update (name, method, version, updated_at) on public.budgets to savia_application;

create policy application_updates_workspace_budgets
  on public.budgets
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(workspace_id)
      in ('owner', 'administrator', 'editor')
  );

commit;
