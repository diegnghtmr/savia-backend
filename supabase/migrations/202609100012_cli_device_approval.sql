begin;

create table public.cli_device_approval_rate_limits (
  subject_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (subject_id, window_start)
);
alter table public.cli_device_approval_rate_limits enable row level security;
alter table public.cli_device_approval_rate_limits force row level security;
grant insert, update on public.cli_device_approval_rate_limits to savia_application;
grant insert, update, select on public.cli_device_approval_rate_limits to savia_elevated;
create policy cli_device_approval_rate_limits_insert
  on public.cli_device_approval_rate_limits for insert to savia_application
  with check (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);
create policy cli_device_approval_rate_limits_update
  on public.cli_device_approval_rate_limits for update to savia_application
  using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid)
  with check (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);
create policy cli_device_approval_rate_limits_elevated
  on public.cli_device_approval_rate_limits for all to savia_elevated
  using (true) with check (true);

create or replace function public.consume_cli_device_approval_rate_limit(p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_subject uuid := nullif(current_setting('app.subject_id', true), '')::uuid;
  v_window timestamptz := (date_trunc('minute', p_now at time zone 'UTC') at time zone 'UTC');
  v_count integer;
begin
  if v_subject is null then raise exception 'authenticated subject required'; end if;
  insert into public.cli_device_approval_rate_limits(subject_id, window_start, request_count)
  values (v_subject, v_window, 1)
  on conflict (subject_id, window_start)
  do update set request_count = cli_device_approval_rate_limits.request_count + 1
  returning request_count into v_count;
  return v_count <= 10;
end $$;

create or replace function public.approve_cli_device_authorization(p_user_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_subject uuid := nullif(current_setting('app.subject_id', true), '')::uuid;
begin
  if v_subject is null then raise exception 'authenticated subject required'; end if;
  update public.cli_device_authorizations
  set approved_at = coalesce(approved_at, now()),
      approved_by_subject_id = coalesce(approved_by_subject_id, v_subject)
  where user_code = p_user_code
    and redeemed_at is null
    and (
      (approved_at is null and expires_at > now())
      or approved_by_subject_id = v_subject
    );
  return found;
end $$;

create or replace function public.insert_cli_device_token(
  p_token_hash text, p_subject_id uuid, p_device_code_hash text, p_scopes text[], p_expires_at timestamptz
) returns void language sql security definer set search_path = public as $$
  insert into public.cli_device_tokens(token_hash, subject_id, device_code_hash, scopes, expires_at)
  select p_token_hash, approved_by_subject_id, device_code_hash, scopes, p_expires_at
  from public.cli_device_authorizations
  where device_code_hash = p_device_code_hash
    and approved_by_subject_id = p_subject_id and redeemed_at is not null
    and scopes = p_scopes;
$$;

grant update, select on public.cli_device_authorizations to savia_elevated;
create policy cli_device_authorizations_approve_elevated
  on public.cli_device_authorizations for update to savia_elevated
  using (true) with check (true);

drop policy cli_device_authorizations_approve on public.cli_device_authorizations;
create policy cli_device_authorizations_approve on public.cli_device_authorizations
  for update to savia_application
  using (
    redeemed_at is null
    and (
      (approved_at is null and expires_at > now())
      or approved_by_subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
    )
  )
  with check (
    approved_at is not null
    and approved_by_subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
  );

grant usage, create on schema public to savia_elevated;
revoke create on schema public from savia_elevated;

revoke all on function public.consume_cli_device_approval_rate_limit(timestamptz) from public;
grant execute on function public.consume_cli_device_approval_rate_limit(timestamptz) to savia_application;
revoke all on function public.approve_cli_device_authorization(text) from public;
grant execute on function public.approve_cli_device_authorization(text) to savia_application;

commit;
