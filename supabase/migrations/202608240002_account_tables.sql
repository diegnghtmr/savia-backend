begin;

-- Epica 2 slice 2: the workspace accounts table.
--
-- Deliberate absences, both load-bearing:
-- - NO balance column, cached or otherwise. PRD FR-ACC-003: "No se permitira
--   modificar el saldo directamente" and PRD:622 "Los saldos se calcularan a
--   partir de las partidas." A stored balance would make that rule
--   unenforceable; balances are computed from postings in a later slice.
-- - NO unique constraint on name. Nothing in the PRD, the TRD or the contract
--   requires account names to be unique inside a workspace.

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  type text not null check (type in ('cash','savings','checking','digital_wallet','credit_card','loan','investment_manual','receivable','generic')),
  -- Precedent: 202607150001_identity_tables.sql:11,20 (uppercase ISO-4217 alpha-3).
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active' check (status in ('active','archived','closed')),
  institution text check (char_length(institution) <= 120),
  masked_number text check (char_length(masked_number) <= 32),
  description text check (char_length(description) <= 500),
  color_token text,
  icon text,
  include_in_net_worth boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  -- The 202607150004 optimistic-concurrency pattern.
  version integer not null default 1 check (version >= 1),
  -- A closed account always carries its closure timestamp; an open one never does.
  check ((status = 'closed') = (closed_at is not null))
);

-- Keyset pagination shape read by postgres-workspace.adapter.ts listWorkspaces:
-- (workspace_id, created_at, id).
create index accounts_workspace_keyset_idx
  on public.accounts (workspace_id, created_at, id);

-- fitness:financial is OPT-IN: scripts/verify-financial-tables.mjs only asserts
-- rules for tables whose comment carries this tag. Its matcher collapses SQL
-- doubled-quote escapes ('') before looking for the tag, so an ordinary
-- apostrophe inside the text no longer un-tags the table.
comment on table public.accounts is 'Workspace financial account. fitness:financial';

-- Carry-over from slice 1 (202608240001): that migration gave
-- command_idempotency_records its workspace_id but no tag, so nothing stopped a
-- future migration from dropping the column again. The tag makes
-- verify-financial-tables.mjs assert the column must stay.
comment on table public.command_idempotency_records is 'Replay records for workspace-scoped commands. fitness:financial';

alter table public.accounts enable row level security;
alter table public.accounts force row level security;

-- Grants: COLUMN-SCOPED where a write path must not re-point a row. workspace_id
-- is excluded from UPDATE on purpose: a table-wide grant would let a write path
-- re-point an account into another workspace and seize it (202607150011:10-14,
-- 202607150014:58-59). color_token and icon stay out of the UPDATE grant too:
-- they are response-only fields and no contract request can carry them yet, so
-- no write path may exercise them (least privilege; widen the grant only when a
-- request schema grows the field). created_by, id and workspace_id are immutable
-- after creation.
grant select on public.accounts to savia_application;
grant insert (workspace_id, name, type, currency, institution, masked_number,
              description, include_in_net_worth, created_by)
  on public.accounts to savia_application;
grant update (name, institution, masked_number, description,
              include_in_net_worth, status, closed_at, updated_at, version)
  on public.accounts to savia_application;
-- No delete grant: accounts are closed, never deleted (PRD:519).

-- Every policy routes through the security-definer helper
-- public.workspace_actor_active_role (202607150011:26-40). A policy that
-- subqueries membership directly risks 42P17 infinite recursion; the helper
-- also fails closed by returning NULL for non-members.
create policy application_reads_workspace_account
  on public.accounts
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(accounts.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_account
  on public.accounts
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(accounts.workspace_id)
      in ('owner', 'administrator', 'editor')
    -- Adapter-supplied attribution is forgeable; bind created_by to the
    -- authenticated subject (202607150007, 202607150014:91-93).
    and accounts.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

-- `using` reads `status`, which the granted column list allows mutating, so an
-- explicit `with check` earns its keep (202607150010:42-46). It DROPS the
-- status <> 'closed' clause on purpose: PostgreSQL applies `using` as the
-- with-check when none is declared, and that would make closing unreachable
-- (the new row's status IS 'closed'). One-way closure comes from `using`
-- filtering closed rows out of every later statement, not from `with check`.
create policy application_updates_workspace_account
  on public.accounts
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(accounts.workspace_id)
      in ('owner', 'administrator', 'editor')
    and accounts.status <> 'closed'
  )
  with check (
    public.workspace_actor_active_role(accounts.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

commit;
