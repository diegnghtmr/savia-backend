begin;

-- Enumerate the server's timezone names once, not for every claim or digest
-- recipient. Use only exact catalog names, not every value AT TIME ZONE parses.
-- Refresh this snapshot if a Postgres/tzdata upgrade changes the listed names.
create table public.notification_delivery_timezone_names (
  name text primary key
);
insert into public.notification_delivery_timezone_names (name)
select name from pg_catalog.pg_timezone_names;

alter table public.notification_delivery_timezone_names enable row level security;
alter table public.notification_delivery_timezone_names force row level security;
revoke all on public.notification_delivery_timezone_names
  from public, anon, authenticated, service_role, savia_application, savia_worker;
grant select on public.notification_delivery_timezone_names to savia_notification_delivery;
create policy delivery_reads_timezone_names on public.notification_delivery_timezone_names
  for select to savia_notification_delivery using (true);

-- CREATE OR REPLACE preserves the existing owner and EXECUTE grants.
create or replace function public.notification_delivery_timezone(p_zone text) returns text
language sql stable set search_path = pg_catalog as $$
  select coalesce((select name from public.notification_delivery_timezone_names where name = p_zone), 'UTC');
$$;

commit;
