do $$
declare
  owner_id constant uuid := '00000000-0000-0000-0000-000000000001';
  other_id constant uuid := '00000000-0000-0000-0000-000000000002';
  designated_id constant uuid := '00000000-0000-0000-0000-000000000003';
  v_workspace_id uuid;
  personal_workspace_id uuid;
  moved_workspace_id uuid;
begin
  insert into auth.users (id, email) values
    (owner_id, 'owner@example.test'),
    (other_id, 'other@example.test'),
    (designated_id, 'designated@example.test');
  insert into public.profiles (
    id, email, display_name, locale, country_code, timezone, date_format,
    week_starts_on, number_format, default_currency
  ) values
    (owner_id, 'owner@example.test', 'Owner', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD'),
    (other_id, 'other@example.test', 'Other', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD'),
    (designated_id, 'designated@example.test', 'Designated', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD');
  insert into public.workspaces (name, kind, base_currency, personal_owner_profile_id)
  values ('Personal', 'personal', 'USD', owner_id) returning id into personal_workspace_id;
  insert into public.workspace_memberships (workspace_id, profile_id, role)
  values (personal_workspace_id, owner_id, 'owner');
  set constraints all immediate;
  if not exists (
    select 1 from public.profiles profile
    join public.workspace_memberships membership on membership.profile_id = profile.id
    where membership.workspace_id = personal_workspace_id
      and profile.privacy_mode_enabled = false
      and membership.status = 'active'
  ) then
    raise exception 'valid ownership/default contract did not persist';
  end if;
  begin
    set constraints all deferred;
    insert into public.workspaces (name, kind, base_currency)
    values ('Moved owner target', 'shared', 'USD') returning id into moved_workspace_id;
    update public.workspace_memberships
    set workspace_id = moved_workspace_id
    where workspace_id = personal_workspace_id and profile_id = owner_id;
    set constraints all immediate;
    raise exception using errcode = 'P0002', message = 'sole owner move committed';
  exception when sqlstate 'P0001' then null;
  end;
  if not exists (
    select 1 from public.workspace_memberships membership
    where membership.workspace_id = personal_workspace_id
      and membership.profile_id = owner_id
      and membership.role = 'owner'
      and membership.status = 'active'
  ) then
    raise exception 'sole owner move orphaned personal workspace';
  end if;
  begin
    set constraints all deferred;
    delete from public.workspace_memberships
    where workspace_id = personal_workspace_id and profile_id = owner_id;
    if exists (
      select 1 from public.workspace_memberships membership
      where membership.workspace_id = personal_workspace_id
        and membership.profile_id = owner_id
    ) then
      raise exception using errcode = 'P0002', message = 'sole owner delete membership mutation did not execute';
    end if;
    set constraints all immediate;
    raise exception using errcode = 'P0002', message = 'sole owner delete committed';
  exception when sqlstate 'P0001' then null;
  end;
  if not exists (
    select 1 from public.workspace_memberships membership
    where membership.workspace_id = personal_workspace_id
      and membership.profile_id = owner_id
      and membership.role = 'owner'
      and membership.status = 'active'
  ) then
    raise exception 'sole owner delete orphaned personal workspace';
  end if;
  begin
    set constraints all deferred;
    insert into public.workspaces (name, kind, base_currency, personal_owner_profile_id)
    values ('Viewer owner', 'personal', 'USD', other_id) returning id into v_workspace_id;
    insert into public.workspace_memberships (workspace_id, profile_id, role)
    values (v_workspace_id, other_id, 'viewer');
    if not exists (
      select 1 from public.workspace_memberships membership
      where membership.workspace_id = v_workspace_id
        and membership.profile_id = other_id
        and membership.role = 'viewer'
    ) then
      raise exception using errcode = 'P0002', message = 'viewer membership mutation did not execute';
    end if;
    set constraints all immediate;
    raise exception using errcode = 'P0002', message = 'viewer owner committed';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    set constraints all deferred;
    insert into public.workspaces (name, kind, base_currency, personal_owner_profile_id)
    values ('Suspended owner', 'personal', 'USD', other_id) returning id into v_workspace_id;
    insert into public.workspace_memberships (workspace_id, profile_id, role, status)
    values (v_workspace_id, other_id, 'owner', 'suspended');
    if not exists (
      select 1 from public.workspace_memberships membership
      where membership.workspace_id = v_workspace_id
        and membership.profile_id = other_id
        and membership.role = 'owner'
        and membership.status = 'suspended'
    ) then
      raise exception using errcode = 'P0002', message = 'suspended owner membership mutation did not execute';
    end if;
    set constraints all immediate;
    raise exception using errcode = 'P0002', message = 'suspended owner committed';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    set constraints all deferred;
    insert into public.workspaces (name, kind, base_currency, personal_owner_profile_id)
    values ('Wrong owner', 'personal', 'USD', designated_id) returning id into v_workspace_id;
    insert into public.workspace_memberships (workspace_id, profile_id, role)
    values (v_workspace_id, other_id, 'owner');
    if not exists (
      select 1 from public.workspace_memberships membership
      where membership.workspace_id = v_workspace_id
        and membership.profile_id = other_id
        and membership.role = 'owner'
    ) then
      raise exception using errcode = 'P0002', message = 'different owner membership mutation did not execute';
    end if;
    set constraints all immediate;
    raise exception using errcode = 'P0002', message = 'different owner committed';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    set constraints all deferred;
    insert into public.workspaces (name, kind, base_currency, personal_owner_profile_id)
    values ('Two owners', 'personal', 'USD', designated_id) returning id into v_workspace_id;
    insert into public.workspace_memberships (workspace_id, profile_id, role)
    values (v_workspace_id, designated_id, 'owner'), (v_workspace_id, other_id, 'owner');
    if (
      select count(*) from public.workspace_memberships membership
      where membership.workspace_id = v_workspace_id
        and membership.role = 'owner'
        and membership.status = 'active'
    ) <> 2 then
      raise exception using errcode = 'P0002', message = 'two active owner membership mutations did not execute';
    end if;
    set constraints all immediate;
    raise exception using errcode = 'P0002', message = 'two owners committed';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    insert into public.profiles (id, email) values ('00000000-0000-0000-0000-000000000099', null);
    raise exception using errcode = 'P0002', message = 'null profile committed';
  exception when not_null_violation then null;
  end;
  begin
    insert into public.workspaces (name, kind, base_currency, personal_owner_profile_id)
    values ('Missing owner', 'personal', 'USD', null);
    raise exception using errcode = 'P0002', message = 'invalid workspace committed';
  exception when check_violation then null;
  end;
  begin
    insert into public.workspace_memberships (workspace_id, profile_id, role)
    values ('00000000-0000-0000-0000-000000000099', owner_id, 'owner');
    raise exception using errcode = 'P0002', message = 'missing workspace committed';
  exception when foreign_key_violation then null;
  end;

  insert into public.workspaces (name, kind, base_currency)
  values ('Shared', 'shared', 'USD') returning id into v_workspace_id;
  begin
    insert into public.workspace_memberships (workspace_id, profile_id, role)
    values (v_workspace_id, owner_id, 'invalid');
    raise exception using errcode = 'P0002', message = 'invalid role committed';
  exception when check_violation then null;
  end;
  begin
    insert into public.workspace_memberships (workspace_id, profile_id, role)
    values (v_workspace_id, owner_id, 'editor'), (v_workspace_id, owner_id, 'viewer');
    raise exception using errcode = 'P0002', message = 'duplicate membership committed';
  exception when unique_violation then null;
  end;
end;
$$;
