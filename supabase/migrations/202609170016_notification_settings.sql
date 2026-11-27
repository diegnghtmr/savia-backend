begin;

alter table public.notification_delivery_preferences
  add column in_app_enabled boolean not null default true,
  add column quiet_timezone text,
  add column version integer not null default 1 check (version > 0),
  add check (quiet_timezone is null or quiet_start is not null);

grant select, insert on public.notification_delivery_preferences to savia_application;
grant update (in_app_enabled, push_enabled, email_enabled, digest_enabled, quiet_start, quiet_end, quiet_timezone, version)
  on public.notification_delivery_preferences to savia_application;
create policy application_manages_own_notification_preferences on public.notification_delivery_preferences
  for all to savia_application using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);

-- Keep the event for external delivery/digest, but never expose it in the inbox
-- if in-app delivery was disabled when the event was produced.
alter table public.notifications add column in_app_visible boolean not null default true;
create policy application_reads_in_app_notifications on public.notifications
  as restrictive for select to savia_application using (in_app_visible);
create function public.apply_notification_in_app_preference() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  new.in_app_visible := coalesce((select f.in_app_enabled
    from public.notification_delivery_preferences f where f.subject_id = new.subject_id), true);
  return new;
end;
$$;
create trigger apply_notification_in_app_preference before insert on public.notifications
  for each row execute function public.apply_notification_in_app_preference();
grant create on schema public to savia_notification_delivery;
alter function public.apply_notification_in_app_preference() owner to savia_notification_delivery;
revoke create on schema public from savia_notification_delivery;
revoke all on function public.apply_notification_in_app_preference()
  from public, anon, authenticated, service_role, savia_application, savia_worker;

create table public.push_devices (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references auth.users(id) on delete cascade,
  expo_token text not null unique check (char_length(expo_token) <= 255
    and expo_token ~ '^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$'),
  platform text not null check (platform in ('ios', 'android')),
  app_version text not null check (char_length(app_version) between 1 and 64),
  active boolean not null default true,
  registration_version uuid not null default gen_random_uuid()
);
create index push_devices_subject_active_idx on public.push_devices(subject_id) where active;
alter table public.push_devices enable row level security;
alter table public.push_devices force row level security;
revoke all on public.push_devices from public, anon, authenticated, service_role, savia_application, savia_worker;
create policy application_manages_own_push_devices on public.push_devices for all to savia_application
  using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);
grant select (id, subject_id, expo_token), insert (subject_id, expo_token, platform, app_version),
  update (platform, app_version, active, registration_version), delete on public.push_devices to savia_application;
create policy delivery_manages_push_devices on public.push_devices for all to savia_notification_delivery
  using (true) with check (true);
grant select (id, subject_id, expo_token, active, registration_version), update (active)
  on public.push_devices to savia_notification_delivery;

-- One parent push row is enqueued transactionally by B7. Fan it out only
-- when due, and use separate, durable leases and retry budgets per device.
-- Device IDs are immutable registration identities, kept on the history rows
-- after deletion. Claims always rejoin by both subject and active device ID.
alter table public.notification_deliveries
  drop constraint notification_deliveries_notification_id_channel_key,
  add column push_device_id uuid,
  add column push_registration_version uuid,
  add check (push_device_id is null or channel = 'push');
create unique index notification_deliveries_enqueue_key
  on public.notification_deliveries (notification_id, channel) where push_device_id is null;
create unique index notification_deliveries_device_key
  on public.notification_deliveries (notification_id, push_device_id) where push_device_id is not null;
grant insert (push_device_id), update (push_registration_version)
  on public.notification_deliveries to savia_notification_delivery;

create or replace function public.enqueue_notification_delivery() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into public.notification_deliveries (subject_id, notification_id, channel)
  values (new.subject_id, new.id, 'email'), (new.subject_id, new.id, 'push')
  on conflict (notification_id, channel) where push_device_id is null do nothing;
  return new;
end;
$$;

drop function public.claim_notification_delivery(boolean);
create function public.claim_notification_delivery(p_email_configured boolean)
returns table (delivery_id uuid, lease_id uuid, lease_expires_at timestamptz, attempts integer,
               recipient text, title text, body text, channel text)
language plpgsql security definer set search_path = pg_catalog as $$
declare
  item public.notification_deliveries%rowtype;
  first_push public.notification_deliveries%rowtype;
  at_time timestamptz := statement_timestamp();
  expires_at timestamptz := at_time + interval '1 minute';
  prefs record;
  local_time timestamp;
  skip_reason text;
  target text;
  registration uuid;
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
           public.notification_delivery_timezone(coalesce(f.quiet_timezone, p.timezone)) as zone
      into prefs from (select item.subject_id as id) s
      left join public.notification_delivery_preferences f on f.subject_id = s.id
      left join public.profiles p on p.id = s.id;

    target := null;
    registration := null;
    if item.channel <> 'push' then target := public.notification_verified_email(item.subject_id); end if;
    skip_reason := case
      when item.channel = 'push' and not prefs.push_enabled then 'channel_disabled'
      when item.channel = 'email' and not prefs.email_enabled then 'channel_disabled'
      when item.channel = 'digest' and not prefs.digest_enabled then 'channel_disabled'
      when item.channel <> 'push' and target is null then 'no_verified_email'
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

    if skip_reason is null and item.channel = 'push' and item.push_device_id is null then
      with added as (
        insert into public.notification_deliveries (subject_id, notification_id, channel, push_device_id, available_at)
        select item.subject_id, item.notification_id, 'push', d.id, at_time
          from public.push_devices d where d.subject_id = item.subject_id and d.active
        returning *
      )
      select * into first_push from added order by id limit 1;
      if found then
        update public.notification_deliveries set status = 'skipped', reason = 'device_fanout',
          resolved_at = at_time, lease_id = null where id = item.id;
        item := first_push;
      else
        skip_reason := 'no_push_device';
      end if;
    end if;
    if skip_reason is null and item.channel = 'push' then
      select d.expo_token, d.registration_version into target, registration
        from public.push_devices d
       where d.id = item.push_device_id and d.subject_id = item.subject_id and d.active;
      if not found then skip_reason := 'push_device_inactive'; end if;
    end if;
    if skip_reason is not null then
      update public.notification_deliveries set status = 'skipped', reason = skip_reason,
        resolved_at = at_time, lease_id = null where id = item.id;
      continue;
    end if;
    token := gen_random_uuid();
    update public.notification_deliveries set attempts = item.attempts + 1, lease_id = token,
      available_at = expires_at, push_registration_version = registration where id = item.id;
    return query select item.id, token, expires_at, item.attempts + 1, target, message_title, message_body, item.channel;
    return;
  end loop;
end;
$$;

-- Fence provider submission itself, not just its acknowledgement. The worker
-- holds this row lock across the bounded send and its outcome transition.
create function public.lock_notification_submission(p_id uuid, p_lease uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog as $$
declare
  item public.notification_deliveries%rowtype;
begin
  select * into item from public.notification_deliveries d
   where d.id = p_id and d.lease_id = p_lease and d.status = 'pending'
   for update skip locked;
  if not found then return false; end if;
  if item.push_device_id is not null then
    -- Prevent a concurrent delete/account switch until the submission finishes.
    perform 1 from public.push_devices d
     where d.id = item.push_device_id and d.subject_id = item.subject_id and d.active
     for key share;
    if not found then return false; end if;
  end if;
  return item.available_at > clock_timestamp() + interval '5 seconds';
end;
$$;

create function public.finish_notification_submission(p_id uuid, p_lease uuid, p_result text, p_seconds integer)
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
begin
  if p_result <> 'device_not_registered' then
    return public.finish_notification_delivery(p_id, p_lease, p_result, p_seconds);
  end if;
  if not exists (select 1 from public.notification_deliveries d where d.id = p_id and d.push_device_id is not null)
     or not public.finish_notification_delivery(p_id, p_lease, 'rejected', p_seconds) then return false; end if;

  update public.push_devices d set active = false
    from public.notification_deliveries n
   where n.id = p_id and d.id = n.push_device_id and d.subject_id = n.subject_id
     and d.registration_version = n.push_registration_version;
  update public.notification_deliveries set reason = 'device_not_registered' where id = p_id;
  return true;
end;
$$;

grant create on schema public to savia_notification_delivery;
alter function public.claim_notification_delivery(boolean) owner to savia_notification_delivery;
alter function public.lock_notification_submission(uuid, uuid) owner to savia_notification_delivery;
alter function public.finish_notification_submission(uuid, uuid, text, integer) owner to savia_notification_delivery;
revoke create on schema public from savia_notification_delivery;
revoke all on function public.claim_notification_delivery(boolean), public.lock_notification_submission(uuid, uuid),
  public.finish_notification_submission(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role, savia_application, savia_worker;
grant execute on function public.claim_notification_delivery(boolean), public.lock_notification_submission(uuid, uuid),
  public.finish_notification_submission(uuid, uuid, text, integer) to savia_worker;

commit;
