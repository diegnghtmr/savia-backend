begin;

-- CLI capability functions run as savia_elevated, a NOBYPASSRLS role. The
-- grants and policies below are deliberately limited to the columns each
-- function reads or writes; savia_application's policies are unchanged.
grant usage, create on schema public to savia_elevated;

grant insert (client_id, ip, window_start, request_count)
  on public.cli_device_rate_limits to savia_elevated;
grant update (request_count) on public.cli_device_rate_limits to savia_elevated;
grant select (client_id, ip, window_start, request_count)
  on public.cli_device_rate_limits to savia_elevated;
create policy cli_device_rate_limits_elevated
  on public.cli_device_rate_limits for all to savia_elevated
  using (true) with check (true);

grant select (
    device_code_hash,
    user_code,
    client_id,
    approved_at,
    approved_by_subject_id,
    scopes,
    expires_at,
    redeemed_at
  )
  on public.cli_device_authorizations to savia_elevated;
grant update (approved_at, approved_by_subject_id)
  on public.cli_device_authorizations to savia_elevated;
grant update (redeemed_at) on public.cli_device_authorizations to savia_elevated;
create policy cli_device_authorizations_elevated_select
  on public.cli_device_authorizations for select to savia_elevated
  using (true);
create policy cli_device_authorizations_elevated_update
  on public.cli_device_authorizations for update to savia_elevated
  using (true) with check (true);

grant insert (token_hash, subject_id, device_code_hash, scopes, expires_at)
  on public.cli_device_tokens to savia_elevated;
grant select (token_hash, subject_id, status, expires_at)
  on public.cli_device_tokens to savia_elevated;
create policy cli_device_tokens_elevated_insert
  on public.cli_device_tokens for insert to savia_elevated
  with check (true);
create policy cli_device_tokens_elevated_select
  on public.cli_device_tokens for select to savia_elevated
  using (true);

revoke all on public.cli_device_approval_rate_limits from savia_elevated;
grant insert (subject_id, window_start, request_count)
  on public.cli_device_approval_rate_limits to savia_elevated;
grant update (request_count)
  on public.cli_device_approval_rate_limits to savia_elevated;
grant select (subject_id, window_start, request_count)
  on public.cli_device_approval_rate_limits to savia_elevated;
drop policy cli_device_approval_rate_limits_elevated
  on public.cli_device_approval_rate_limits;
create policy cli_device_approval_rate_limits_elevated
  on public.cli_device_approval_rate_limits for all to savia_elevated
  using (true) with check (true);

alter function public.consume_cli_device_rate_limit(text, inet, timestamptz)
  set search_path = pg_catalog, public;
alter function public.insert_cli_device_token(text, uuid, text, text[], timestamptz)
  set search_path = pg_catalog, public;
alter function public.approve_cli_device_authorization(text)
  set search_path = pg_catalog, public;
alter function public.redeem_cli_device_authorization(text, text, timestamptz)
  set search_path = pg_catalog, public;
alter function public.verify_cli_device_token(text)
  set search_path = pg_catalog, public;
alter function public.consume_cli_device_approval_rate_limit(timestamptz)
  set search_path = pg_catalog, public;

alter function public.consume_cli_device_rate_limit(text, inet, timestamptz)
  owner to savia_elevated;
alter function public.insert_cli_device_token(text, uuid, text, text[], timestamptz)
  owner to savia_elevated;
alter function public.approve_cli_device_authorization(text)
  owner to savia_elevated;
alter function public.redeem_cli_device_authorization(text, text, timestamptz)
  owner to savia_elevated;
alter function public.verify_cli_device_token(text)
  owner to savia_elevated;
alter function public.consume_cli_device_approval_rate_limit(timestamptz)
  owner to savia_elevated;

revoke create on schema public from savia_elevated;

commit;
