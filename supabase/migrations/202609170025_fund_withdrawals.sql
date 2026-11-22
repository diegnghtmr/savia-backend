begin;

alter table public.funds
  add column objective text check (char_length(objective) between 1 and 500),
  add column responsible_member_ids uuid[] not null default '{}';

grant update (name, objective, target_amount_minor, target_date, linked_account_id,
              responsible_member_ids, version, updated_at)
  on public.funds to savia_application;

create policy application_updates_workspace_funds on public.funds
  for update to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'))
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'));

comment on table public.fund_contributions is
  'Sinking fund ledger links; a negative account posting adds savings and a positive account posting releases savings. fitness:financial';

commit;
