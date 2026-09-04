begin;

create index budgets_workspace_created_at_id_idx
  on public.budgets (workspace_id, created_at asc, id asc);

commit;
