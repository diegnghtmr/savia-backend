begin;

create or replace function public.find_budget_alert_targets(day date, after_id uuid)
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
        and m.status = 'active' and m.role in ('owner', 'administrator', 'editor', 'viewer')
    )
  order by b.id
  limit 50;
$$;

-- No viewer write policy: only the worker can request these two notifications,
-- and the database derives the workspace, recipient and title from the budget.
grant select (name) on public.budgets to savia_elevated;
grant insert (workspace_id, subject_id, type, resource_id, title)
  on public.notifications to savia_elevated;
create policy elevated_inserts_budget_thresholds on public.notifications
  for insert to savia_elevated
  with check (workspace_id is not null and type in ('budget_threshold_80', 'budget_threshold_100'));

create function public.publish_budget_thresholds(target_workspace uuid, target_budget uuid, day date, thresholds integer[])
returns void language sql volatile security definer set search_path = pg_catalog, public
as $$
  insert into public.notifications (workspace_id, subject_id, type, resource_id, title)
  select b.workspace_id, b.created_by, 'budget_threshold_' || level, b.id,
         'Budget “' || b.name || '” reached ' || level || '%'
  from public.budgets b
  cross join unnest(thresholds) level
  where b.id = target_budget and b.workspace_id = target_workspace
    and day between b.period_start and b.period_end and level in (80, 100)
    and exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = b.workspace_id and m.profile_id = b.created_by
        and m.status = 'active' and m.role in ('owner', 'administrator', 'editor', 'viewer')
    )
  on conflict do nothing;
$$;

-- Preserve IDs of already tracked payee series as their keys gain the description.
update public.subscriptions s
set detection_key = encode(sha256(convert_to(jsonb_build_array(
  t.account_id, t.currency, t.payee_id, lower(label.description))::text, 'UTF8')), 'hex')
from public.transactions t
cross join lateral (select nullif(btrim(regexp_replace(t.description, '[[:space:]]+', ' ', 'g')), '') as description) label
where t.workspace_id = s.workspace_id and t.id = s.detection_observation_id
  and t.payee_id is not null and label.description is not null
  and s.detection_key = encode(sha256(convert_to(jsonb_build_array(
    t.account_id, t.currency, t.payee_id, null)::text, 'UTF8')), 'hex');

-- This event key survives a recipient change (or removal) without changing B4's
-- recipient-scoped uniqueness for other producers or deleting historical alerts.
create table public.subscription_notification_events (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type text not null check (type in ('subscription_price_increase', 'subscription_frequency_change')),
  resource_id uuid not null,
  primary key (workspace_id, type, resource_id)
);
insert into public.subscription_notification_events (workspace_id, type, resource_id)
select n.workspace_id, n.type, n.resource_id from public.notifications n
where n.type = 'subscription_price_increase' and n.workspace_id is not null
union all
select n.workspace_id, n.type, md5(jsonb_build_array(s.id, s.detection_observation_id)::text)::uuid
from public.notifications n
join public.subscriptions s on s.workspace_id = n.workspace_id and s.detection_observation_id = n.resource_id
where n.type = 'subscription_price_increase'
on conflict do nothing;
alter table public.subscription_notification_events enable row level security;
alter table public.subscription_notification_events force row level security;
grant insert on public.subscription_notification_events to savia_elevated;
create policy elevated_claims_subscription_events on public.subscription_notification_events
  for insert to savia_elevated with check (true);

create function public.claim_subscription_notification_event()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  -- BEFORE INSERT runs ahead of RLS. An unauthorized application write must
  -- hit its original denial, not infer another subject's event by conflict.
  if new.subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
     and public.workspace_actor_active_role(new.workspace_id) in ('owner', 'administrator', 'editor') then
    insert into public.subscription_notification_events (workspace_id, type, resource_id)
    values (new.workspace_id, new.type, new.resource_id) on conflict do nothing;
    if not found then return null; end if;
  end if;
  return new;
end;
$$;

create trigger claim_subscription_notification_event
before insert on public.notifications for each row
when (new.workspace_id is not null and new.type in ('subscription_price_increase', 'subscription_frequency_change'))
execute function public.claim_subscription_notification_event();

grant create on schema public to savia_elevated;
alter function public.publish_budget_thresholds(uuid, uuid, date, integer[]) owner to savia_elevated;
alter function public.claim_subscription_notification_event() owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke all on function public.publish_budget_thresholds(uuid, uuid, date, integer[]),
  public.claim_subscription_notification_event() from public, anon, authenticated, service_role, savia_application, savia_worker;
grant execute on function public.publish_budget_thresholds(uuid, uuid, date, integer[]) to savia_worker;

commit;
