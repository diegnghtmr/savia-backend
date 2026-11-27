begin;

-- A separate definer role limits access to delivery inputs and transitions.
create role savia_notification_delivery nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant savia_notification_delivery to postgres;
grant usage on schema public to savia_notification_delivery;

-- Supabase owns the auth schema and the migration role cannot delegate its
-- usage. Expose just one verified address to the private delivery definer.
create function public.notification_verified_email(p_subject uuid) returns text
language sql stable security definer set search_path = pg_catalog as $$
  select nullif(btrim(u.email), '') from auth.users u
   where u.id = p_subject and u.email_confirmed_at is not null;
$$;
revoke all on function public.notification_verified_email(uuid)
  from public, anon, authenticated, service_role, savia_application, savia_worker;
grant execute on function public.notification_verified_email(uuid) to savia_notification_delivery;
grant select (id, timezone) on public.profiles to savia_notification_delivery;
create policy delivery_reads_timezones on public.profiles
  for select to savia_notification_delivery using (true);
grant select (workspace_id, profile_id, status) on public.workspace_memberships to savia_notification_delivery;
create policy delivery_checks_active_memberships on public.workspace_memberships
  for select to savia_notification_delivery using (status = 'active');
grant select (id, subject_id, workspace_id, title, body, created_at) on public.notifications to savia_notification_delivery;
create policy delivery_reads_visible_notifications on public.notifications
  for select to savia_notification_delivery using (
    workspace_id is null or exists (
      select 1 from public.workspace_memberships m
       where m.workspace_id = notifications.workspace_id
         and m.profile_id = notifications.subject_id and m.status = 'active'
    )
  );

-- No public preference API. An absent row means all external channels on,
-- no quiet hours. In-app behavior remains unchanged.
create table public.notification_delivery_preferences (
  subject_id uuid primary key references auth.users(id) on delete cascade,
  email_enabled boolean not null default true,
  push_enabled boolean not null default true,
  digest_enabled boolean not null default true,
  quiet_start time,
  quiet_end time,
  check ((quiet_start is null and quiet_end is null) or
         (quiet_start is not null and quiet_end is not null and quiet_start <> quiet_end))
);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references auth.users(id) on delete cascade,
  notification_id uuid references public.notifications(id) on delete cascade,
  channel text not null check (channel in ('email', 'push', 'digest')),
  digest_week date,
  period_start timestamptz,
  period_end timestamptz,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default statement_timestamp(),
  lease_id uuid,
  reason text,
  resolved_at timestamptz,
  unique (notification_id, channel),
  unique (subject_id, digest_week),
  check ((channel = 'digest' and notification_id is null and digest_week is not null
           and period_start is not null and period_end is not null and period_start < period_end)
      or (channel in ('email', 'push') and notification_id is not null and digest_week is null
           and period_start is null and period_end is null)),
  check ((status = 'pending') = (resolved_at is null)),
  check (status = 'pending' or lease_id is null)
);
create index notification_deliveries_due_idx on public.notification_deliveries (available_at, id)
  where status = 'pending';
create index notification_delivery_recent_idx on public.notifications (created_at, subject_id);

alter table public.notification_delivery_preferences enable row level security;
alter table public.notification_delivery_preferences force row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_deliveries force row level security;
revoke all on public.notification_delivery_preferences, public.notification_deliveries
  from public, anon, authenticated, service_role, savia_application, savia_worker;
grant select on public.notification_delivery_preferences, public.notification_deliveries to savia_notification_delivery;
grant insert (subject_id, notification_id, channel, digest_week, period_start, period_end, available_at)
  on public.notification_deliveries to savia_notification_delivery;
grant update (status, attempts, available_at, lease_id, reason, resolved_at)
  on public.notification_deliveries to savia_notification_delivery;
create policy delivery_reads_preferences on public.notification_delivery_preferences
  for select to savia_notification_delivery using (true);
create policy delivery_manages_outbox on public.notification_deliveries
  for all to savia_notification_delivery using (true) with check (true);

-- Transactional enqueue for new notifications. Do not replay historical immediate sends.
create function public.enqueue_notification_delivery() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into public.notification_deliveries (subject_id, notification_id, channel)
  values (new.subject_id, new.id, 'email'), (new.subject_id, new.id, 'push')
  on conflict (notification_id, channel) do nothing;
  return new;
end;
$$;
create trigger enqueue_notification_delivery after insert on public.notifications
  for each row execute function public.enqueue_notification_delivery();

create function public.notification_delivery_timezone(p_zone text) returns text
language sql stable set search_path = pg_catalog as $$
  select coalesce((select name from pg_timezone_names where name = p_zone), 'UTC');
$$;

-- The timestamp-taking helper is not exposed to the worker. A local Monday
-- covers the prior civil week (not 7x24 UTC hours when DST changes).
create function public.prepare_notification_digests(p_at timestamptz) returns integer
language sql security definer set search_path = pg_catalog as $$
  with recipients as (
    select distinct n.subject_id from public.notifications n
     where extract(isodow from p_at at time zone 'UTC') in (7, 1, 2)
       and n.created_at >= p_at - interval '9 days' and n.created_at < p_at
  ), local_days as materialized (
    select r.subject_id, z.zone, (p_at at time zone z.zone)::date as local_day
      from recipients r left join public.profiles p on p.id = r.subject_id
      cross join lateral (select public.notification_delivery_timezone(p.timezone) as zone) z
  ), weeks as (
    select l.subject_id, l.local_day - 7 as week,
           (l.local_day - 7)::timestamp at time zone l.zone as starts,
           l.local_day::timestamp at time zone l.zone as ends
      from local_days l where extract(isodow from l.local_day) = 1
  ), inserted as (
    insert into public.notification_deliveries (subject_id, channel, digest_week, period_start, period_end, available_at)
    select w.subject_id, 'digest', w.week, w.starts, w.ends, p_at
      from weeks w
     where not exists (select 1 from public.notification_deliveries d where d.subject_id = w.subject_id and d.digest_week = w.week)
       and exists (select 1 from public.notifications n where n.subject_id = w.subject_id and n.created_at >= w.starts and n.created_at < w.ends)
     order by w.subject_id limit 200
    on conflict (subject_id, digest_week) do nothing returning 1
  )
  select count(*)::integer from inserted;
$$;

create function public.schedule_notification_digests() returns integer
language sql security definer set search_path = pg_catalog as $$
  select public.prepare_notification_digests(statement_timestamp());
$$;

-- Claim a single send without holding a transaction open across provider I/O.
-- The lease UUID fences late acknowledgements after crash recovery.
create function public.claim_notification_delivery(p_email_configured boolean)
returns table (delivery_id uuid, lease_id uuid, attempts integer, recipient text, title text, body text)
language plpgsql security definer set search_path = pg_catalog as $$
declare
  item public.notification_deliveries%rowtype;
  at_time timestamptz := statement_timestamp();
  prefs record;
  local_time timestamp;
  skip_reason text;
  message_title text;
  message_body text;
  total bigint;
  token uuid;
begin
  for item in
    select d.* from public.notification_deliveries d
     where d.status = 'pending' and d.available_at <= at_time
       and (p_email_configured or d.channel = 'push')
     order by d.available_at, d.id limit 20 for update skip locked
  loop
    if item.attempts = 5 then
      update public.notification_deliveries set status = 'failed', reason = 'lease_expired',
        resolved_at = at_time, lease_id = null where id = item.id;
      continue;
    end if;

    select coalesce(f.email_enabled, true) as email_enabled,
           coalesce(f.push_enabled, true) as push_enabled,
           coalesce(f.digest_enabled, true) as digest_enabled,
           f.quiet_start, f.quiet_end,
           public.notification_verified_email(s.id) as email,
           public.notification_delivery_timezone(p.timezone) as zone
      into prefs from (select item.subject_id as id) s
      left join public.notification_delivery_preferences f on f.subject_id = s.id
      left join public.profiles p on p.id = s.id;

    skip_reason := case
      when item.channel = 'push' and not prefs.push_enabled then 'channel_disabled'
      when item.channel = 'push' then 'no_push_device'
      when item.channel = 'email' and not prefs.email_enabled then 'channel_disabled'
      when item.channel = 'digest' and not prefs.digest_enabled then 'channel_disabled'
      when prefs.email is null then 'no_verified_email'
    end;
    if skip_reason is null then
      local_time := at_time at time zone prefs.zone;
      if (case when prefs.quiet_start < prefs.quiet_end
        then local_time::time >= prefs.quiet_start and local_time::time < prefs.quiet_end
        else local_time::time >= prefs.quiet_start or local_time::time < prefs.quiet_end end)
      then
        update public.notification_deliveries
           set available_at = ((local_time::date + case
                  when prefs.quiet_start > prefs.quiet_end and local_time::time >= prefs.quiet_start then 1
                  else 0 end) + prefs.quiet_end) at time zone prefs.zone,
               lease_id = null
         where id = item.id;
        continue;
      end if;

      if item.channel = 'digest' then
        select count(*), string_agg('- ' || n.title, E'\n' order by n.ord) filter (where n.ord <= 20)
          into total, message_body
          from (
            select src.title, row_number() over (order by src.created_at, src.id) as ord
              from public.notifications src
             where src.subject_id = item.subject_id and src.created_at >= item.period_start and src.created_at < item.period_end
          ) n;
        if total = 0 then
          skip_reason := 'no_visible_notifications';
        else
          message_title := 'Savia weekly digest · ' || to_char(item.digest_week, 'YYYY-MM-DD');
          message_body := total || case when total = 1 then ' notification' else ' notifications' end
                         || E'\n' || message_body;
        end if;
      else
        select n.title, n.body into message_title, message_body from public.notifications n
         where n.id = item.notification_id and n.subject_id = item.subject_id;
        if not found then skip_reason := 'workspace_access_lost'; end if;
      end if;
    end if;

    if skip_reason is not null then
      update public.notification_deliveries set status = 'skipped', reason = skip_reason,
        resolved_at = at_time, lease_id = null where id = item.id;
      continue;
    end if;
    token := gen_random_uuid();
    update public.notification_deliveries set attempts = item.attempts + 1, lease_id = token,
      available_at = at_time + interval '1 minute' where id = item.id;
    return query select item.id, token, item.attempts + 1, prefs.email, message_title, message_body;
    return;
  end loop;
end;
$$;

create function public.finish_notification_delivery(p_id uuid, p_lease uuid, p_result text, p_seconds integer)
returns boolean language sql security definer set search_path = pg_catalog as $$
  with saved as (
    update public.notification_deliveries d
       set status = case when p_result = 'accepted' then 'accepted'
                         when p_result = 'rejected' or d.attempts = 5 then 'failed' else 'pending' end,
           reason = case when p_result = 'rejected' then 'provider_rejected'
                         when p_result = 'retryable' and d.attempts = 5 then 'attempts_exhausted'
                         when p_result = 'retryable' then 'provider_retryable' end,
           available_at = case when p_result = 'retryable' and d.attempts < 5
                               then statement_timestamp() + make_interval(secs => p_seconds)
                               else statement_timestamp() end,
           resolved_at = case when p_result <> 'retryable' or d.attempts = 5 then statement_timestamp() end,
           lease_id = null
     where d.id = p_id and d.lease_id = p_lease and d.status = 'pending'
       and d.available_at > statement_timestamp()
       and p_result in ('accepted', 'rejected', 'retryable') and p_seconds between 1 and 300
    returning 1
  )
  select exists (select 1 from saved);
$$;

grant create on schema public to savia_notification_delivery;
alter function public.enqueue_notification_delivery() owner to savia_notification_delivery;
alter function public.notification_delivery_timezone(text) owner to savia_notification_delivery;
alter function public.prepare_notification_digests(timestamptz) owner to savia_notification_delivery;
alter function public.schedule_notification_digests() owner to savia_notification_delivery;
alter function public.claim_notification_delivery(boolean) owner to savia_notification_delivery;
alter function public.finish_notification_delivery(uuid, uuid, text, integer) owner to savia_notification_delivery;
revoke create on schema public from savia_notification_delivery;
revoke all on function public.enqueue_notification_delivery(), public.notification_delivery_timezone(text),
  public.prepare_notification_digests(timestamptz), public.schedule_notification_digests(),
  public.claim_notification_delivery(boolean), public.finish_notification_delivery(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role, savia_application, savia_worker;
grant execute on function public.schedule_notification_digests(), public.claim_notification_delivery(boolean),
  public.finish_notification_delivery(uuid, uuid, text, integer) to savia_worker;

commit;
