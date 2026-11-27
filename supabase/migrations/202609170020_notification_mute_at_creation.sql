begin;

-- Decide event-channel eligibility when the notification is enqueued. An
-- existing push intent carries that decision through later per-device fan-out.
create or replace function public.enqueue_notification_delivery() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into public.notification_deliveries (subject_id, notification_id, channel)
  select new.subject_id, new.id, candidate.channel
    from (values ('email'), ('push')) as candidate(channel)
    left join public.notification_delivery_preferences f on f.subject_id = new.subject_id
   where case candidate.channel
           when 'email' then coalesce(f.email_enabled, true)
           else coalesce(f.push_enabled, true)
         end
  on conflict (notification_id, channel) where push_device_id is null do nothing;
  return new;
end;
$$;

-- Keep the 0016 lease and fan-out behavior. Digest enablement remains
-- independent; quiet hours are evaluated when delivery is attempted.
create or replace function public.claim_notification_delivery(p_email_configured boolean)
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

    select coalesce(f.digest_enabled, true) as digest_enabled,
           f.quiet_start, f.quiet_end,
           public.notification_delivery_timezone(coalesce(f.quiet_timezone, p.timezone)) as zone
      into prefs from (select item.subject_id as id) s
      left join public.notification_delivery_preferences f on f.subject_id = s.id
      left join public.profiles p on p.id = s.id;

    target := null;
    registration := null;
    if item.channel <> 'push' then target := public.notification_verified_email(item.subject_id); end if;
    skip_reason := case
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

commit;
