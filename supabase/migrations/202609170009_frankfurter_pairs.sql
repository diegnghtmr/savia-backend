begin;

-- The existing conversion paths quote one unit of account currency in the
-- workspace currency. Reuse the RLS-scoped reads of savia_elevated and expose
-- only the distinct currency pairs (not account or workspace metadata).
create function public.list_frankfurter_pairs()
returns table (workspace_id uuid, base_currency text, quote_currency text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select distinct w.id, a.currency::text, w.base_currency::text
    from public.accounts a
    join public.workspaces w on w.id = a.workspace_id
   where a.status = 'active' and a.currency <> w.base_currency
   order by 2, 3, 1;
$$;

revoke all on function public.list_frankfurter_pairs()
  from public, anon, authenticated, service_role;
grant execute on function public.list_frankfurter_pairs() to savia_worker;

grant create on schema public to savia_elevated;
alter function public.list_frankfurter_pairs() owner to savia_elevated;
revoke create on schema public from savia_elevated;

commit;
