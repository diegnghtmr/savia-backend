begin;

-- Epica 2 slice 15: public.transfers and the composite posting binding.
--
-- Transfers represent movement of funds between two distinct accounts in the
-- same workspace. The contract authority defines Transfer with sourceAccountId,
-- destinationAccountId, sourceAmount, destinationAmount, optional fee, nullable
-- exchangeRate/referenceRate, occurredAt, status, and optional transactionId
-- linking a fee transaction.
--
-- Deliberate load-bearing architectural rulings:
-- - Composite foreign keys on (workspace_id, source_account_id), (workspace_id, destination_account_id),
--   and optional (workspace_id, transaction_id) pin all related entities into the transfer's workspace (RULING 48).
-- - Distinct accounts check: a self-transfer (source_account_id = destination_account_id) is unrepresentable.
-- - Postings binding: ledger_postings (workspace_id, transfer_id) references transfers (workspace_id, id)
--   on delete restrict. Under MATCH SIMPLE (PostgreSQL default), transaction-parented legs with
--   transfer_id NULL skip this check; transfer-parented legs are structurally constrained to the same workspace.
-- - No delete grant and no delete policy: transfers are financial history.

create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_account_id uuid not null,
  destination_account_id uuid not null,
  -- Minor units are bigint counts, strictly positive for both legs (TRD §22.1).
  source_amount_minor bigint not null check (source_amount_minor > 0),
  source_currency char(3) not null check (source_currency ~ '^[A-Z]{3}$'),
  destination_amount_minor bigint not null check (destination_amount_minor > 0),
  destination_currency char(3) not null check (destination_currency ~ '^[A-Z]{3}$'),
  -- Fee is optional; if present, amount must be positive and currency valid.
  fee_amount_minor bigint check (fee_amount_minor is null or fee_amount_minor > 0),
  fee_currency char(3) check (fee_currency is null or fee_currency ~ '^[A-Z]{3}$'),
  -- Exchange and reference rates are stored as decimal strings (OpenAPI DecimalString).
  exchange_rate text,
  reference_rate text,
  occurred_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft','pending','confirmed','reconciled','voided')),
  -- Optional transaction_id linking a fee transaction.
  transaction_id uuid,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version >= 1),
  -- A self-transfer is meaningless and unrepresentable.
  constraint transfers_distinct_accounts_check
    check (source_account_id <> destination_account_id),
  -- Fee amount and currency must be set together or both null.
  constraint transfers_fee_parity_check
    check ((fee_amount_minor is null) = (fee_currency is null)),
  -- Composite unique key required for composite foreign key references from child tables.
  constraint transfers_workspace_id_id_key
    unique (workspace_id, id),
  -- Composite foreign keys to accounts (RULING 48):
  constraint transfers_source_account_workspace_fkey
    foreign key (workspace_id, source_account_id)
    references public.accounts (workspace_id, id)
    on delete restrict,
  constraint transfers_destination_account_workspace_fkey
    foreign key (workspace_id, destination_account_id)
    references public.accounts (workspace_id, id)
    on delete restrict,
  -- Optional fee transaction composite foreign key:
  constraint transfers_transaction_workspace_fkey
    foreign key (workspace_id, transaction_id)
    references public.transactions (workspace_id, id)
    on delete restrict
);

-- Keyset pagination index: (workspace_id, occurred_at desc, id).
create index transfers_workspace_occurred_keyset_idx
  on public.transfers (workspace_id, occurred_at desc, id);

create index transfers_workspace_source_account_idx
  on public.transfers (workspace_id, source_account_id);

create index transfers_workspace_destination_account_idx
  on public.transfers (workspace_id, destination_account_id);

create index transfers_transaction_idx
  on public.transfers (transaction_id);

comment on table public.transfers is 'Workspace transfer header. fitness:financial';

alter table public.transfers enable row level security;
alter table public.transfers force row level security;

-- Grants: COLUMN-SCOPED where a write path must not re-point a row.
-- workspace_id, source_account_id, destination_account_id, source_amount_minor,
-- source_currency, destination_amount_minor, destination_currency, fee_amount_minor,
-- fee_currency, exchange_rate, reference_rate, created_by and id are immutable after insert.
grant select on public.transfers to savia_application;
grant insert (workspace_id, source_account_id, destination_account_id,
              source_amount_minor, source_currency,
              destination_amount_minor, destination_currency,
              fee_amount_minor, fee_currency,
              exchange_rate, reference_rate,
              occurred_at, status, transaction_id, created_by)
  on public.transfers to savia_application;
grant update (status, occurred_at, updated_at, version)
  on public.transfers to savia_application;
-- No delete grant and no delete policy: transfers are financial history.

-- Policies routed through public.workspace_actor_active_role helper.
create policy application_reads_workspace_transfer
  on public.transfers
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(transfers.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_transfer
  on public.transfers
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(transfers.workspace_id)
      in ('owner', 'administrator', 'editor')
    and transfers.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_workspace_transfer
  on public.transfers
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(transfers.workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(transfers.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

-- Epica 2 slice 15: bind ledger_postings to public.transfers via composite foreign key.
--
-- With MATCH SIMPLE (the PostgreSQL default), a row whose transfer_id is null
-- (such as transaction-parented legs) skips the composite FK entirely.
-- Restrict preserves financial history if a transfer is ever targeted for deletion.
alter table public.ledger_postings
  add constraint ledger_postings_transfer_workspace_fkey
  foreign key (workspace_id, transfer_id)
  references public.transfers (workspace_id, id)
  on delete restrict;

commit;
