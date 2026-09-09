begin;

alter table public.cli_device_authorizations
  add column approved_by_subject_id uuid references auth.users(id) on delete cascade,
  add column redeemed_at timestamptz;

-- Approval and redemption updates are exposed only through the capability
-- functions below. These policies remain defense-in-depth for any future
-- invoker-owned path, but the pooled application role has no direct UPDATE
-- privilege on authorization rows.
create policy cli_device_authorizations_approve on public.cli_device_authorizations
  for update to savia_application
  using (
    approved_at is null
    and expires_at > now()
    and nullif(current_setting('app.subject_id', true), '') is not null
  )
  with check (
    approved_at is not null
    and approved_by_subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
  );
create policy cli_device_authorizations_redeem on public.cli_device_authorizations
  for update to savia_application
  using (approved_at is not null and expires_at > now() and redeemed_at is null)
  with check (approved_at is not null);

create table public.cli_device_tokens (
  token_hash text primary key,
  subject_id uuid not null references auth.users(id) on delete cascade,
  device_code_hash text not null references public.cli_device_authorizations(device_code_hash),
  scopes text[] not null,
  status text not null default 'active',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint cli_device_tokens_status_check check (status in ('active', 'revoked', 'expired')),
  constraint cli_device_tokens_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint cli_device_tokens_expiry check (expires_at > created_at)
);
alter table public.cli_device_tokens enable row level security;
alter table public.cli_device_tokens force row level security;
grant insert (token_hash, subject_id, device_code_hash, scopes, expires_at) on public.cli_device_tokens to savia_application;
grant update (status) on public.cli_device_tokens to savia_application;
create policy cli_device_tokens_insert on public.cli_device_tokens for insert to savia_application with check (false);
create policy cli_device_tokens_update on public.cli_device_tokens
  for update to savia_application
  using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid)
  with check (
    subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and status in ('revoked', 'expired')
  );

create or replace function public.insert_cli_device_token(
  p_token_hash text, p_subject_id uuid, p_device_code_hash text, p_scopes text[], p_expires_at timestamptz
) returns void language sql security definer set search_path = public as $$
  insert into public.cli_device_tokens(token_hash, subject_id, device_code_hash, scopes, expires_at)
  select p_token_hash, approved_by_subject_id, device_code_hash, scopes, expires_at
  from public.cli_device_authorizations
  where device_code_hash = p_device_code_hash
    and approved_by_subject_id = p_subject_id and redeemed_at is not null
    and scopes = p_scopes and expires_at = p_expires_at;
$$;
create or replace function public.approve_cli_device_authorization(p_user_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_subject uuid := nullif(current_setting('app.subject_id', true), '')::uuid;
begin
  if v_subject is null then raise exception 'authenticated subject required'; end if;
  update public.cli_device_authorizations
  set approved_at = now(), approved_by_subject_id = v_subject
  where user_code = p_user_code and approved_at is null and expires_at > now();
  return found;
end $$;
create or replace function public.redeem_cli_device_authorization(
  p_device_code_hash text, p_client_id text, p_now timestamptz
) returns table(subject_id uuid, scopes text[], expires_at timestamptz)
language sql security definer set search_path = public as $$
  update public.cli_device_authorizations
  set redeemed_at = p_now
  where device_code_hash = p_device_code_hash and client_id = p_client_id
    and approved_at is not null and expires_at > p_now and redeemed_at is null
  returning approved_by_subject_id, cli_device_authorizations.scopes, cli_device_authorizations.expires_at;
$$;
create or replace function public.verify_cli_device_token(p_token_hash text)
returns table(subject_id uuid) language sql security definer set search_path = public as $$
  select subject_id from public.cli_device_tokens
  where token_hash = p_token_hash and status = 'active' and expires_at > now();
$$;
revoke all on function public.insert_cli_device_token(text, uuid, text, text[], timestamptz) from public;
grant execute on function public.insert_cli_device_token(text, uuid, text, text[], timestamptz) to savia_application;
revoke all on function public.approve_cli_device_authorization(text) from public;
grant execute on function public.approve_cli_device_authorization(text) to savia_application;
revoke all on function public.redeem_cli_device_authorization(text, text, timestamptz) from public;
grant execute on function public.redeem_cli_device_authorization(text, text, timestamptz) to savia_application;
revoke all on function public.verify_cli_device_token(text) from public;
grant execute on function public.verify_cli_device_token(text) to savia_application;

commit;
