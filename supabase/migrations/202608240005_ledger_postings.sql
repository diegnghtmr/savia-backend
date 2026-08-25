begin;

-- Epica 2 slice 4: public.ledger_postings -- the double-entry core.
--
-- The PRD's "Reglas del libro" is binding: "Toda transaccion contable tendra
-- partidas balanceadas" and "Los saldos se calcularan a partir de las
-- partidas". The contract authority has NO Posting schema and NO postings
-- endpoints, so this module publishes nothing over HTTP: no controller, no
-- port exposed over HTTP, no OpenAPI change (operationCount stays 15). TRD
-- SS11 lists ledger as a module distinct from accounts, hence its own
-- namespace. It arrives fourth because it takes foreign keys to BOTH accounts
-- (slice 2) and transactions (slice 3).
--
-- Deliberate absences, all load-bearing rulings:
-- - NO single-column foreign keys on transaction_id/account_id (RULING 48).
--   PostgreSQL referential-integrity checks ALWAYS bypass row security by
--   design, so an id-only FK let a member of workspace A reference workspace
--   B's row (the slice 3 defect): the poison row then bricked
--   DELETE /v1/workspaces/B with 23503 permanently, with no API path to
--   remove it. Both references below are COMPOSITE on (workspace_id, <ref>),
--   making a cross-workspace reference unrepresentable rather than merely
--   refused -- and as a second dividend, every transaction-parented posting
--   group is pinned into a single workspace by construction.
-- - NO foreign key on transfer_id yet. Slice 15 creates transfers and adds
--   the binding; until then the column stores what the service supplies.
-- - NO 'voided' status. A void APPENDS a reversing set; it never restates a
--   posting (RULING 29). With 'voided' here the balance query would need a
--   status special-case, and the whole design depends on it not needing one.
--
-- The external leg: income and expense have no second in-workspace account
-- until Epica 4 ships categories. Rather than let the PRD's balanced-postings
-- rule be false in the meantime, every posting set carries an explicit
-- counter-leg with leg_kind = 'external' and account_id null. It nets the set
-- to zero and drops out of the balance query through its account_id = $2
-- filter. Epica 4 replaces it with a category leg without touching the
-- invariant.

-- A composite foreign key needs a matching unique constraint on the
-- referenced side. accounts already carries unique (workspace_id, id) from
-- the slice 3 fix round (202608240004); transactions does NOT. Added HERE --
-- the merged 202608240003 migration is not edited.
alter table public.transactions
  add constraint transactions_workspace_id_id_key unique (workspace_id, id);

create table public.ledger_postings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Nullable: exactly one parent per leg
  -- (ledger_postings_parent_exactly_one_check below). With MATCH SIMPLE (the
  -- default), a row whose transaction_id is null skips the composite FK
  -- entirely, which is exactly what a transfer-parented leg needs.
  transaction_id uuid,
  account_id uuid,
  -- No foreign key yet: slice 15 creates transfers and binds it.
  transfer_id uuid,
  leg_kind text not null check (leg_kind in ('account', 'external')),
  -- Signed minor units (TRD SS22.1): a debit and its credit differ only in
  -- sign.
  amount_minor bigint not null,
  -- Precedent: 202607150001_identity_tables.sql:11,20 (uppercase ISO-4217
  -- alpha-3).
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  -- Deliberately NO 'voided' value (RULING 29): see the header comment.
  status text not null check (status in ('draft', 'pending', 'confirmed', 'reconciled')),
  -- Denormalized at write time so the balance query stays single-table.
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- An account leg carries its account; an external leg carries none.
  -- Named so tests can pin the CONCRETE refuser, not just a message family.
  constraint ledger_postings_account_leg_parity_check
    check ((leg_kind = 'account') = (account_id is not null)),
  -- A leg belongs to exactly one parent. Named for the same reason.
  constraint ledger_postings_parent_exactly_one_check
    check (num_nonnulls(transaction_id, transfer_id) = 1),
  -- RULING 48, both instances. Restrict preserves financial history if a
  -- sibling row is ever removed out-of-band; the workspace cascade (above)
  -- removes postings together with everything they reference, so the
  -- slice 3 denial of service stays dissolved structurally.
  constraint ledger_postings_account_workspace_fkey
    foreign key (workspace_id, account_id)
    references public.accounts (workspace_id, id)
    on delete restrict,
  constraint ledger_postings_transaction_workspace_fkey
    foreign key (workspace_id, transaction_id)
    references public.transactions (workspace_id, id)
    on delete restrict
);

-- Balance-query covering index: filter (workspace_id, account_id, status,
-- occurred_at), payload amount_minor. External legs drop out through the
-- query's account_id = $2 filter.
create index ledger_postings_balance_idx
  on public.ledger_postings (workspace_id, account_id, status, occurred_at)
  include (amount_minor);

create index ledger_postings_transaction_idx
  on public.ledger_postings (transaction_id);

create index ledger_postings_transfer_idx
  on public.ledger_postings (transfer_id);

comment on table public.ledger_postings is 'Double-entry posting leg. fitness:financial';

alter table public.ledger_postings enable row level security;
alter table public.ledger_postings force row level security;

-- Grants. No request in the contract writes a posting directly, so the insert
-- grant exists for the ledger service, not for a client; it covers exactly
-- the columns a service must supply and nothing else (id and created_at are
-- defaulted).
grant select on public.ledger_postings to savia_application;
grant insert (workspace_id, transaction_id, transfer_id, account_id, leg_kind,
              amount_minor, currency, status, occurred_at)
  on public.ledger_postings to savia_application;
-- Column-scoped: ONLY status. Amount, account, currency and identity are
-- immutable BY GRANT, not by convention (idiom: 202607150014:60).
grant update (status)
  on public.ledger_postings to savia_application;
-- No delete grant and no delete policy: the ledger is append-only (RULING 29).

-- Every policy routes through the security-definer helper
-- public.workspace_actor_active_role (202607150011:26-40). A policy that
-- subqueries membership directly risks 42P17 infinite recursion; the helper
-- also fails closed by returning NULL for non-members.
create policy application_reads_workspace_posting
  on public.ledger_postings
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(ledger_postings.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_posting
  on public.ledger_postings
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(ledger_postings.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

-- `using` reads `status`, which the granted column list allows mutating, so an
-- explicit `with check` earns its keep (202607150010:42-46).
create policy application_updates_workspace_posting
  on public.ledger_postings
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(ledger_postings.workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(ledger_postings.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

-- The balanced-postings trigger below is SECURITY DEFINER owned by
-- savia_elevated (a nobypassrls role), and this table FORCEs row level
-- security, so the grant alone yields zero rows (precedent:
-- 202607150013:11-15). Without THIS POLICY the function would aggregate an
-- empty table, the raise would be unreachable, and the invariant would be a
-- silent no-op that still appears to work.
create policy elevated_reads_ledger_postings
  on public.ledger_postings
  for select
  to savia_elevated
  using (true);

-- THE BALANCED-POSTINGS INVARIANT (PRD "Reglas del libro"): every posting set
-- sums to zero per currency and has at least two legs.
--
-- A row CHECK cannot express a set-level sum, and a NON-deferred trigger would
-- reject the perfectly legitimate intermediate state right after the FIRST leg
-- of a set is inserted. So it is a deferred constraint trigger -- this repo
-- already solved the isomorphic invariant at 202607150001:87-95 and
-- 202607150012:103-106, with the raise form at 202607150012:87-88.
--
-- security definer here is LOAD-BEARING, not decoration: as an invoker-rights
-- function, the scan below would run under the writing subject, whose reads
-- this table's own FORCE row level security filters -- the exact blindness
-- documented at 202607150007:3-9 -- and could aggregate a PARTIAL group: an
-- invariant that silently fails while appearing to work.
grant usage, create on schema public to savia_elevated;   -- revoked below (RULING 13)
grant select on public.ledger_postings to savia_elevated;

create function public.enforce_balanced_ledger_postings()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Scoped to the affected parent: NEW on insert/update, OLD on delete
  -- (reading the unassigned row's field yields NULL in PL/pgSQL, hence the
  -- coalesce pair). ledger_postings_parent_exactly_one_check guarantees
  -- exactly one term is non-null, so no cross-parent OR-leak is possible;
  -- the where has already scoped the scan to one parent, so grouping by
  -- currency alone is exact. The parent indexes make this Theta(group size)
  -- per firing. A whole-table scan here was Theta(N*M) per commit inside the
  -- commit critical path with no usable index, and coupled every workspace's
  -- writes to any out-of-band unbalanced group anywhere in the database,
  -- reported with an error naming no group.
  if exists (
    select 1
    from public.ledger_postings posting
    where posting.transaction_id = coalesce(new.transaction_id, old.transaction_id)
       or posting.transfer_id    = coalesce(new.transfer_id, old.transfer_id)
    group by posting.currency
    having sum(posting.amount_minor) <> 0
        or count(*) < 2
  ) then
    raise exception 'ledger postings must balance to zero per currency'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

alter function public.enforce_balanced_ledger_postings() owner to savia_elevated;

-- Immediately after the ownership transfer, never later (RULING 13; a
-- permanent grant was the C4 defect).
revoke create on schema public from savia_elevated;

-- Trigger-only helper: no direct execute path needs it.
revoke execute on function public.enforce_balanced_ledger_postings() from public;

create constraint trigger enforce_balanced_ledger_postings_from_posting
after insert or update or delete on public.ledger_postings
deferrable initially deferred
for each row execute function public.enforce_balanced_ledger_postings();

commit;
