do $$
declare
  visible_version integer;
begin
  -- `is distinct from`, not `<>`: an absent or invisible row yields null, and a null `if` condition never raises.
  if (select version from public.workspaces where id = '00000000-0000-0000-0000-000000000403') is distinct from 1 then
    raise exception 'upgrade did not backfill existing workspace';
  end if;
  insert into public.workspaces (name, kind, base_currency)
  values ('Upgrade default', 'shared', 'USD');
  if not exists (select 1 from public.workspaces where name = 'Upgrade default' and version = 1) then
    raise exception 'upgrade omitted version did not default to 1';
  end if;
  if not has_table_privilege('savia_application', 'public.workspaces', 'SELECT')
    or not has_table_privilege('savia_application', 'public.workspaces', 'INSERT')
    or has_table_privilege('savia_application', 'public.workspaces', 'UPDATE')
    or has_table_privilege('savia_application', 'public.workspaces', 'DELETE')
    or not (select relforcerowsecurity from pg_class where oid = 'public.workspaces'::regclass) then
    raise exception 'workspace security posture changed';
  end if;
  set local role savia_application;
  perform set_config('app.subject_id', '00000000-0000-0000-0000-000000000401', true);
  select version into visible_version from public.workspaces where id = '00000000-0000-0000-0000-000000000403';
  -- Reachable here: hiding this row from its own owner leaves visible_version null.
  if visible_version is distinct from 1 or exists (select 1 from public.workspaces where name = 'Upgrade default') then
    raise exception 'workspace visibility or isolation changed';
  end if;
end;
$$;
