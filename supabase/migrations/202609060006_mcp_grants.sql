begin;

-- The parameter is deliberately NOT named `values`: that is a reserved word in
-- PostgreSQL, and `cardinality(values)` inside the body parses as the start of a
-- VALUES clause, so `create function` fails with `syntax error at or near "values"`.
-- Because every integration suite applies every migration, that one word took the
-- whole disposable-database gate down, not just this table.
create function public.mcp_array_is_unique(items anyarray)
returns boolean language sql immutable strict as $$
  select cardinality(items) = (select count(distinct value) from unnest(items) as entries(value));
$$;

create table public.mcp_grants (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references auth.users(id) on delete cascade,
  client_name text not null,
  scopes text[] not null,
  workspace_ids uuid[] not null,
  account_ids uuid[],
  max_write_amount_minor bigint,
  max_write_currency char(3),
  status text not null default 'active',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_grants_status_check check (status in ('active', 'revoked')),
  constraint mcp_grants_client_name_length_check check (char_length(client_name) between 1 and 120),
  constraint mcp_grants_scopes_check check (cardinality(scopes) > 0 and scopes <@ array['accounts:read','accounts:write','budgets:read','budgets:write','reports:read','reports:write','transactions:read','transactions:write','workspace:admin']::text[]),
  constraint mcp_grants_scopes_unique_check check (public.mcp_array_is_unique(scopes)),
  constraint mcp_grants_workspace_ids_unique_check check (public.mcp_array_is_unique(workspace_ids)),
  constraint mcp_grants_account_ids_unique_check check (account_ids is null or public.mcp_array_is_unique(account_ids)),
  constraint mcp_grants_amount_pair_check check ((max_write_amount_minor is null) = (max_write_currency is null)),
  constraint mcp_grants_revoked_at_check check ((status = 'revoked') = (revoked_at is not null))
);

create index mcp_grants_subject_created_at_id_idx on public.mcp_grants (subject_id, created_at asc, id asc);
alter table public.mcp_grants enable row level security;
alter table public.mcp_grants force row level security;
grant select on public.mcp_grants to savia_application;
grant insert (subject_id, id, client_name, scopes, workspace_ids, account_ids, max_write_amount_minor, max_write_currency, expires_at) on public.mcp_grants to savia_application;
grant update (status, revoked_at) on public.mcp_grants to savia_application;
-- Subject-scoped like notifications; there is no workspace-membership helper to route through this table.
create policy mcp_grants_select_own on public.mcp_grants for select to savia_application using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);
create policy mcp_grants_insert_own on public.mcp_grants for insert to savia_application with check (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);
create policy mcp_grants_update_own on public.mcp_grants for update to savia_application using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid) with check (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);
-- HTTP DELETE is a status change, not a SQL DELETE; deliberately grant no delete privilege.
-- Arrays cannot carry foreign keys. A future join table would preserve referential integrity when workspaces are deleted;
-- this slice keeps the contract's capability record compact and reports the dangling-id tradeoff instead.
revoke all on function public.mcp_array_is_unique(anyarray) from public;
commit;
