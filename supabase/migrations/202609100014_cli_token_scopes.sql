begin;

grant usage, create on schema public to savia_elevated;

drop function public.verify_cli_device_token(text);

create function public.verify_cli_device_token(p_token_hash text)
returns table(subject_id uuid, scopes text[])
language sql security definer set search_path = pg_catalog, public as $$
  select subject_id, scopes
  from public.cli_device_tokens
  where token_hash = p_token_hash
    and status = 'active'
    and expires_at > now();
$$;

alter function public.verify_cli_device_token(text) owner to savia_elevated;
grant select (scopes)
  on public.cli_device_tokens to savia_elevated;

revoke all on function public.verify_cli_device_token(text) from public;
grant execute on function public.verify_cli_device_token(text) to savia_application;

revoke create on schema public from savia_elevated;

commit;
