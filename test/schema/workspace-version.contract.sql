do $$
declare
  workspace_id uuid;
  v_schema_name text;
  v_table_name text;
  v_column_name text;
  v_constraint_name text;
begin
  if not exists (
    select 1 from information_schema.columns
    where columns.table_schema = 'public' and columns.table_name = 'workspaces'
      and columns.column_name = 'version' and columns.data_type = 'integer'
      and is_nullable = 'NO' and column_default = '1'
  ) then raise exception 'workspace version metadata is incomplete'; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.workspaces'::regclass
      and conname = 'workspaces_version_gte_1' and contype = 'c'
      and pg_get_constraintdef(oid) = 'CHECK ((version >= 1))'
  ) then raise exception 'workspace version check is incomplete'; end if;

  insert into public.workspaces (name, kind, base_currency)
  values ('Default version', 'shared', 'USD') returning id into workspace_id;
  if (select version from public.workspaces where id = workspace_id) <> 1 then
    raise exception 'omitted version did not default to 1';
  end if;
  -- Both explicit cases are required. The value 1 proves the valid lower bound
  -- persists; a non-default value proves an explicit version is honoured rather
  -- than silently replaced by DEFAULT 1. With only the value 1, this test would
  -- be indistinguishable from the omitted-column test above, so a regression
  -- that dropped the supplied value would pass unnoticed.
  insert into public.workspaces (name, kind, base_currency, version)
  values ('Explicit version', 'shared', 'USD', 1);
  if not exists (select 1 from public.workspaces where name = 'Explicit version' and version = 1) then
    raise exception 'explicit valid version did not persist';
  end if;
  insert into public.workspaces (name, kind, base_currency, version)
  values ('Explicit non-default version', 'shared', 'USD', 7);
  if not exists (select 1 from public.workspaces where name = 'Explicit non-default version' and version = 7) then
    raise exception 'explicit non-default version did not persist';
  end if;
  begin
    insert into public.workspaces (name, kind, base_currency, version)
    values ('Null version', 'shared', 'USD', null);
    raise exception using errcode = 'P0002', message = 'null version committed';
  exception when not_null_violation then
    get stacked diagnostics v_schema_name = schema_name, v_table_name = table_name, v_column_name = column_name;
    if v_schema_name <> 'public' or v_table_name <> 'workspaces' or v_column_name <> 'version' then
      raise exception '23502 diagnostics did not identify public.workspaces.version';
    end if;
  end;
  foreach workspace_id in array array['00000000-0000-0000-0000-000000000000'::uuid] loop
    begin
      insert into public.workspaces (name, kind, base_currency, version)
      values ('Invalid zero', 'shared', 'USD', 0);
      raise exception using errcode = 'P0002', message = 'zero version committed';
    exception when check_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name <> 'workspaces_version_gte_1' then raise exception 'zero diagnostic mismatch'; end if;
    end;
    begin
      insert into public.workspaces (name, kind, base_currency, version)
      values ('Invalid negative', 'shared', 'USD', -1);
      raise exception using errcode = 'P0002', message = 'negative version committed';
    exception when check_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name <> 'workspaces_version_gte_1' then raise exception 'negative diagnostic mismatch'; end if;
    end;
  end loop;
end;
$$;
