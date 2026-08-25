begin;

-- Epica 2 slice 3: the workspace transactions table (ledger header).
--
-- Deliberate absences, both binding rulings:
-- - NO 'transfer' value in the type check. FR-LED-005 forbids booking a
--   transfer as income or expense, and RULING 32 makes a transfer its own row,
--   not a Transaction; the authority's TransactionType enum has no 'transfer'.
-- - NO splits column. RULING 33 refuses splits with a 422 until Epica 4 ships
--   categories, so a column nothing may populate would be dead schema.

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  type text not null check (type in ('income','expense','adjustment','refund','debt_payment','fund_contribution')),
  status text not null default 'draft' check (status in ('draft','pending','confirmed','reconciled','voided')),
  -- TRD §22.1: money in minor units is an integer count, never a float and
  -- never numeric here.
  amount_minor bigint not null,
  -- Precedent: 202607150001_identity_tables.sql:11,20 (uppercase ISO-4217 alpha-3).
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  description text check (char_length(description) <= 500),
  notes text check (char_length(notes) <= 2000),
  source text check (source in ('web','mobile','cli','mcp','agent','import','system')),
  -- RULING 44: nullable with NO foreign key. The categories, payees, receipts
  -- and reconciliations tables arrive in Epicas 4 and 5, which also add the
  -- FKs; until then the server stores whatever the client supplied and reads
  -- it back.
  category_id uuid,
  payee_id uuid,
  receipt_id uuid,
  reconciliation_id uuid,
  tag_ids uuid[],
  voided_at timestamptz,
  -- A voided transaction always carries its void timestamp; a live one never
  -- does (idiom: 202607150001_identity_tables.sql:22).
  check ((status = 'voided') = (voided_at is not null)),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The 202607150004 optimistic-concurrency pattern.
  version integer not null default 1 check (version >= 1)
);

-- Keyset pagination shape for listTransactions.
create index transactions_workspace_occurred_keyset_idx
  on public.transactions (workspace_id, occurred_at desc, id);

-- closeAccount's RULING 30 precondition query: open draft/pending
-- transactions blocking closure of one account inside a workspace.
create index transactions_workspace_account_status_idx
  on public.transactions (workspace_id, account_id, status);

comment on table public.transactions is 'Ledger transaction header. fitness:financial';

alter table public.transactions enable row level security;
alter table public.transactions force row level security;

-- Grants: COLUMN-SCOPED where a write path must not re-point a row.
-- workspace_id and account_id are excluded from UPDATE on purpose: a
-- table-wide grant would let a write path re-point a transaction into another
-- workspace or onto another account and seize it (202607150011:12-14,
-- 202607150014:58-59).
--
-- The write columns are exactly what the contract can reach, no wider:
-- - source and reconciliation_id get NO insert grant because neither
--   CreateTransactionRequest nor any other request carries them yet; they stay
--   NULL until a slice widens the grant together with the request schema that
--   needs it (the color_token/icon precedent from the accounts review).
-- - amount_minor gets NO update grant: UpdateTransactionRequest has no amount
--   field, and VoidTransactionRequest carries only a reason, so no contract
--   request can mutate a stored amount after creation.
-- - voided_at IS updatable even though no request FIELD carries it: the
--   contract's void OPERATION must stamp it, and the table's own check keeps
--   it paired with status='voided' in both directions.
-- - updated_at and version back If-Match optimistic concurrency, which every
--   mutating operation must bump.
grant select on public.transactions to savia_application;
grant insert (workspace_id, account_id, type, status, amount_minor, currency,
              occurred_at, description, notes, category_id, payee_id,
              receipt_id, tag_ids, created_by)
  on public.transactions to savia_application;
grant update (status, occurred_at, description, notes, category_id, payee_id,
              tag_ids, voided_at, updated_at, version)
  on public.transactions to savia_application;
-- No delete grant and no delete policy: transactions are voided, never
-- deleted.

-- Every policy routes through the security-definer helper
-- public.workspace_actor_active_role (202607150011:26-40). A policy that
-- subqueries membership directly risks 42P17 infinite recursion; the helper
-- also fails closed by returning NULL for non-members.
create policy application_reads_workspace_transaction
  on public.transactions
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(transactions.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_transaction
  on public.transactions
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(transactions.workspace_id)
      in ('owner', 'administrator', 'editor')
    -- Adapter-supplied attribution is forgeable; bind created_by to the
    -- authenticated subject (202607150007, 202607150014:91-93).
    and transactions.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

-- `using` reads `status`, which the granted column list allows mutating, so an
-- explicit `with check` earns its keep (202607150010:42-46). It DROPS the
-- status <> 'voided' clause on purpose: PostgreSQL applies `using` as the
-- with-check when none is declared, and that would make voiding unreachable
-- (the NEW row's status IS 'voided'). One-way voiding comes from `using`
-- filtering voided rows out of every later statement, not from `with check`.
create policy application_updates_workspace_transaction
  on public.transactions
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(transactions.workspace_id)
      in ('owner', 'administrator', 'editor')
    and transactions.status <> 'voided'
  )
  with check (
    public.workspace_actor_active_role(transactions.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

commit;
