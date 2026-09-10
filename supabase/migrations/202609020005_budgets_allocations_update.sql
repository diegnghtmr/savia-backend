begin;

-- Epica 6 slice 3: full replacement of budget allocations.
grant delete on public.budget_allocations to savia_application;
create policy application_deletes_workspace_budget_allocations
  on public.budget_allocations
  for delete
  to savia_application
  using (
    public.workspace_actor_active_role(workspace_id)
      in ('owner','administrator','editor')
  );
alter table public.budget_allocations
  add constraint budget_allocations_rollover_target_category_workspace_fkey
  foreign key (workspace_id,rollover_target_id)
  references public.categories(workspace_id,id)
  on delete restrict;

commit;
