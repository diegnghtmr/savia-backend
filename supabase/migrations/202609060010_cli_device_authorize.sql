begin;

create table public.cli_device_authorizations (
  device_code_hash text primary key,
  user_code text not null unique,
  client_id text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz not null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint cli_device_authorizations_user_code_format check (user_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  constraint cli_device_authorizations_expiry check (expires_at > created_at)
);
grant insert on public.cli_device_authorizations to savia_application;
alter table public.cli_device_authorizations enable row level security;
alter table public.cli_device_authorizations force row level security;
create policy cli_device_authorizations_insert on public.cli_device_authorizations for insert to savia_application with check (true);

create table public.cli_device_rate_limits (
  client_id text not null,
  ip inet not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (client_id, ip, window_start)
);
grant insert, update on public.cli_device_rate_limits to savia_application;
alter table public.cli_device_rate_limits enable row level security;
alter table public.cli_device_rate_limits force row level security;
create policy cli_device_rate_limits_insert on public.cli_device_rate_limits for insert to savia_application with check (true);
create policy cli_device_rate_limits_update on public.cli_device_rate_limits for update to savia_application using (true) with check (true);

create or replace function public.consume_cli_device_rate_limit(p_client_id text, p_ip inet, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := (date_trunc('minute', p_now at time zone 'UTC') at time zone 'UTC');
  v_count integer;
begin
  insert into public.cli_device_rate_limits(client_id, ip, window_start, request_count)
  values (p_client_id, p_ip, v_window, 1)
  on conflict (client_id, ip, window_start)
  do update set request_count = cli_device_rate_limits.request_count + 1
  returning request_count into v_count;
  return v_count <= 10;
end $$;
revoke execute on function public.consume_cli_device_rate_limit(text,inet,timestamptz) from public;
grant execute on function public.consume_cli_device_rate_limit(text,inet,timestamptz) to savia_application;
commit;
