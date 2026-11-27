begin;

-- Legacy subscriptions retain NULL detector metadata and are not claimed by the sweep.
alter table public.subscriptions
  add column detection_key text,
  add column detection_observed_at timestamptz,
  add column detection_observation_id uuid,
  add constraint subscriptions_detection_key unique (workspace_id, detection_key),
  add constraint subscriptions_detection_metadata_complete check (
    (detection_key is null and detection_observed_at is null and detection_observation_id is null)
    or (detection_key is not null and detection_observed_at is not null and detection_observation_id is not null)
  );
grant insert (detection_key, detection_observed_at, detection_observation_id),
      update (detection_observed_at, detection_observation_id)
  on public.subscriptions to savia_application;

-- Reuse the elevated role's membership read grants. No transaction or subscription
-- data leaves application RLS, and the worker may not access either table directly.
create function public.find_subscription_detection_targets(after_id uuid)
returns table ("workspaceId" uuid, subject uuid)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select w.id, actor.profile_id
  from public.workspaces w
  cross join lateral (
    select m.profile_id
    from public.workspace_memberships m
    where m.workspace_id = w.id and m.status = 'active'
      and m.role in ('owner', 'administrator', 'editor')
    order by case m.role when 'owner' then 0 when 'administrator' then 1 else 2 end,
      m.profile_id
    limit 1
  ) actor
  where after_id is null or w.id > after_id
  order by w.id
  limit 25;
$$;

grant create on schema public to savia_elevated;
alter function public.find_subscription_detection_targets(uuid) owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke all on function public.find_subscription_detection_targets(uuid)
  from public, anon, authenticated, service_role, savia_application;
grant execute on function public.find_subscription_detection_targets(uuid) to savia_worker;

commit;
