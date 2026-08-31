begin;

-- Epica 5 slice 2: public.reconciliations table.
--
-- RULING 69: systemBalance and difference are COMPUTED, never client-supplied.
-- systemBalance is the account's balance as of the end of statementDate, derived
-- from the existing ledger. difference = statementBalance - systemBalance, computed
-- in integer minor units. Both are stored on the row at creation time so the
-- reconciliation is a snapshot, not a moving target.
--
-- RULING 70: currency is the account's, and a mismatch is 422.
-- statementBalance.currency MUST equal the account's currency.
-- systemBalance and difference carry that same currency.
--
-- RULING 71: one OPEN reconciliation per account.
-- Creating a second reconciliation for an account that already has one in status 'open'
-- answers 409. Enforce it in the database with a PARTIAL UNIQUE INDEX
-- reconciliations_one_open_per_account_idx on (workspace_id, account_id) where status = 'open'.
--
-- RULING 72: statementDate must not be in the future.
-- A statement dated after today (UTC) answers 422. Dates are UTC-only.
--
-- RULING 73: the account must exist, be in this workspace, and not be closed.
-- Enforce workspace containment with a COMPOSITE foreign key (workspace_id, account_id)
-- referencing public.accounts (workspace_id, id) per RULING 48.
--
-- RULING 74: completion columns are constrained now, used in 5.3.
-- completed_at is NOT NULL exactly when status = 'completed', NULL otherwise,
-- enforced by named CHECK reconciliations_completed_at_check.
-- Status is CHECK-constrained to ('open', 'completed', 'cancelled').
--
-- RULING 75: idempotency is claimed BEFORE the row is inserted.
-- Order: idempotencyStore.read -> insert -> idempotencyStore.write -> reread.
--
-- Architectural Decisions:
-- D1. Workspace-scoped table: public.reconciliations.
--     Uses `workspace_id uuid not null references public.workspaces(id) on delete cascade`,
--     matching the house convention.
--     Carries `constraint reconciliations_workspace_id_id_key unique (workspace_id, id)`
--     for future composite foreign keys (RULING 48).
--
-- D2. Composite foreign key for account containment (RULING 48 / RULING 73):
--     `foreign key (workspace_id, account_id) references public.accounts (workspace_id, id) on delete restrict`.
--
-- D3. Partial unique index for one open reconciliation per account (RULING 71):
--     `create unique index reconciliations_one_open_per_account_idx on public.reconciliations (workspace_id, account_id) where status = 'open'`.
--
-- D4. Status, currency format, notes length, and calculation invariants (RULING 70 / RULING 74 / RULING 76):
--     Named CHECK constraints for status, statement_currency, notes length, completed_at lifecycle,
--     and difference calculation consistency.
--
-- D5. RLS and Grants:
--     Reads permitted for active workspace members (owner, administrator, editor, viewer).
--     Inserts permitted for active owner, administrator, editor bound to `app.subject_id`.
--     Updates permitted for active owner, administrator, editor (column-scoped to status, completed_at for slice 5.3).
--     Grants to savia_application: select, column-scoped insert, and column-scoped update.
--     No delete privileges.

create table public.reconciliations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null,
  statement_date date not null,
  statement_balance_minor bigint not null,
  statement_currency char(3) not null
    constraint reconciliations_statement_currency_format_check
    check (statement_currency ~ '^[A-Z]{3}$'),
  system_balance_minor bigint not null,
  difference_minor bigint not null,
  status text not null
    constraint reconciliations_status_check
    check (status in ('open', 'completed', 'cancelled')),
  notes text
    constraint reconciliations_notes_length_check
    check (notes is null or length(notes) <= 1000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint reconciliations_workspace_id_id_key
    unique (workspace_id, id),
  constraint reconciliations_account_workspace_fkey
    foreign key (workspace_id, account_id)
    references public.accounts (workspace_id, id)
    on delete restrict,
  constraint reconciliations_completed_at_check
    check (
      (status = 'completed' and completed_at is not null)
      or (status <> 'completed' and completed_at is null)
    ),
  constraint reconciliations_difference_calculation_check
    check (difference_minor = statement_balance_minor - system_balance_minor)
);

create unique index reconciliations_one_open_per_account_idx
  on public.reconciliations (workspace_id, account_id)
  where status = 'open';

create index reconciliations_created_by_idx
  on public.reconciliations (created_by);

create index reconciliations_workspace_created_at_idx
  on public.reconciliations (workspace_id, created_at, id);

create index reconciliations_workspace_account_idx
  on public.reconciliations (workspace_id, account_id, created_at, id);

comment on table public.reconciliations is 'Workspace reconciliations. fitness:financial. RULINGS 69-75: snapshot balances, composite FK, one open reconciliation per account.';

-- Row Level Security
alter table public.reconciliations enable row level security;
alter table public.reconciliations force row level security;

-- Grants: COLUMN-SCOPED insert and update grants for least privilege.
-- workspace_id, created_by, created_at, and id are immutable after insertion.
-- No delete privileges exist.
grant select on public.reconciliations to savia_application;
grant insert (
  workspace_id,
  account_id,
  statement_date,
  statement_balance_minor,
  statement_currency,
  system_balance_minor,
  difference_minor,
  status,
  notes,
  created_by
) on public.reconciliations to savia_application;
grant update (
  status,
  completed_at
) on public.reconciliations to savia_application;

-- Policies routed through public.workspace_actor_active_role helper.
create policy application_reads_workspace_reconciliations
  on public.reconciliations
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(reconciliations.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_reconciliations
  on public.reconciliations
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(reconciliations.workspace_id)
      in ('owner', 'administrator', 'editor')
    and reconciliations.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_workspace_reconciliations
  on public.reconciliations
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(reconciliations.workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(reconciliations.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

commit;
