begin;

-- The migration role owns these functions. The application role receives
-- EXECUTE only. PgTransaction binds the verified subject transaction-locally.
create function public.savia_session_is_active(session_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions s where s.id = session_id
      and s.user_id = nullif(pg_catalog.current_setting('app.subject_id', true), '')::uuid
      and (s.not_after is null or s.not_after > pg_catalog.statement_timestamp())
  );
$$;

create function public.savia_list_sessions(current_id uuid, after_at timestamptz, after_id uuid, page_limit integer)
returns table(id uuid, created_at timestamptz, last_active_at timestamptz, user_agent text)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.created_at,
         greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'UTC'), s.user_agent
  from auth.sessions s
  where s.user_id = nullif(pg_catalog.current_setting('app.subject_id', true), '')::uuid
    and (s.not_after is null or s.not_after > pg_catalog.statement_timestamp())
    and public.savia_session_is_active(current_id)
    and (after_at is null or (s.created_at, s.id) > (after_at, after_id))
  order by s.created_at, s.id
  limit least(greatest(page_limit, 0), 201);
$$;

create function public.savia_revoke_other_sessions(current_id uuid) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.savia_session_is_active(current_id) then return false; end if;
  -- GoTrue's session foreign keys cascade to refresh tokens, as with sign-out.
  delete from auth.sessions s
  where s.user_id = nullif(pg_catalog.current_setting('app.subject_id', true), '')::uuid
    and s.id <> current_id
    and (s.not_after is null or s.not_after > pg_catalog.statement_timestamp());
  return true;
end;
$$;

revoke all on function public.savia_session_is_active(uuid),
  public.savia_list_sessions(uuid, timestamptz, uuid, integer), public.savia_revoke_other_sessions(uuid)
  from public, anon, authenticated, service_role, savia_worker, savia_elevated;
grant execute on function public.savia_session_is_active(uuid),
  public.savia_list_sessions(uuid, timestamptz, uuid, integer), public.savia_revoke_other_sessions(uuid)
  to savia_application;

commit;
