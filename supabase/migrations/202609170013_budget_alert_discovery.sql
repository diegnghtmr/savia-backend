begin;

-- Worker discovery sees only routing metadata; allocation reads and
-- notification writes run as the budget creator under application RLS.
grant select (id, workspace_id, created_by, period_start, period_end)
  on public.budgets to savia_elevated;
create policy elevated_reads_budget_alert_targets on public.budgets
  for select to savia_elevated using (true);

create function public.find_budget_alert_targets(day date, after_id uuid)
returns table ("budgetId" uuid, "workspaceId" uuid, subject uuid)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select b.id, b.workspace_id, b.created_by
  from public.budgets b
  where day between b.period_start and b.period_end
    and (after_id is null or b.id > after_id)
    and exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = b.workspace_id and m.profile_id = b.created_by
        and m.status = 'active' and m.role in ('owner', 'administrator', 'editor')
    )
  order by b.id
  limit 50;
$$;

grant create on schema public to savia_elevated;
alter function public.find_budget_alert_targets(date, uuid) owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke all on function public.find_budget_alert_targets(date, uuid)
  from public, anon, authenticated, service_role, savia_application;
grant execute on function public.find_budget_alert_targets(date, uuid) to savia_worker;

commit;
