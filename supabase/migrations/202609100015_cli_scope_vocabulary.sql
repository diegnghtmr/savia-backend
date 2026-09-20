begin;

do $$
declare
  invalid_count bigint;
begin
  select count(*) into invalid_count
    from public.cli_device_authorizations
   where not (scopes <@ array[
     'accounts:read', 'accounts:write',
     'transactions:read', 'transactions:write',
     'budgets:read', 'budgets:write',
     'reports:read', 'reports:write',
     'workspace:admin'
   ]::text[]);

  select invalid_count + count(*) into invalid_count
    from public.cli_device_tokens
   where not (scopes <@ array[
     'accounts:read', 'accounts:write',
     'transactions:read', 'transactions:write',
     'budgets:read', 'budgets:write',
     'reports:read', 'reports:write',
     'workspace:admin'
   ]::text[]);

  if invalid_count > 0 then
    raise exception
      'CLI scope vocabulary refused to install: % invalid row(s); remove unknown scopes before retrying the migration',
      invalid_count;
  end if;
end;
$$;

alter table public.cli_device_authorizations
  add constraint cli_device_authorizations_scopes_check
  check (scopes <@ array[
    'accounts:read', 'accounts:write',
    'transactions:read', 'transactions:write',
    'budgets:read', 'budgets:write',
    'reports:read', 'reports:write',
    'workspace:admin'
  ]::text[]);

alter table public.cli_device_tokens
  add constraint cli_device_tokens_scopes_check
  check (scopes <@ array[
    'accounts:read', 'accounts:write',
    'transactions:read', 'transactions:write',
    'budgets:read', 'budgets:write',
    'reports:read', 'reports:write',
    'workspace:admin'
  ]::text[]);

commit;
