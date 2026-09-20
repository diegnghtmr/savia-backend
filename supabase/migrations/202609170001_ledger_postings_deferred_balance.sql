begin;

-- Finding 1: Replace row-level deferred constraint trigger on ledger_postings
-- with an unlogged bookkeeping table and set-based deferred balance verification.
--
-- Legacy enforce_balanced_ledger_postings_from_posting evaluated once per posting row
-- inside COMMIT (O(N) trigger firings, ~20s for 10k rows).
-- The new design uses:
-- 1. An unlogged bookkeeping table (public.ledger_balance_pending) storing touched parent keys.
-- 2. A cheap per-row trigger on public.ledger_postings recording affected parent keys.
-- 3. A deferred constraint trigger on public.ledger_balance_pending that executes once per transaction,
--    verifying ledger balance across all touched parents in a single set-based query and clearing pending rows.

-- 1. Bookkeeping table
create unlogged table public.ledger_balance_pending (
  txid xid8 not null,
  transaction_id uuid,
  transfer_id uuid,
  constraint ledger_balance_pending_parent_check check (
    num_nonnulls(transaction_id, transfer_id) = 1
  ),
  constraint ledger_balance_pending_unique unique nulls not distinct (txid, transaction_id, transfer_id)
);

comment on table public.ledger_balance_pending is
  'Transaction-scoped parent keys pending ledger balance verification at commit.';

alter table public.ledger_balance_pending enable row level security;
alter table public.ledger_balance_pending force row level security;

revoke all on public.ledger_balance_pending from public;

grant select, insert, delete on public.ledger_balance_pending to savia_elevated;

create policy elevated_manages_ledger_balance_pending
  on public.ledger_balance_pending
  for all
  to savia_elevated
  using (true)
  with check (true);

-- 2. Drop legacy trigger and function
drop trigger if exists enforce_balanced_ledger_postings_from_posting on public.ledger_postings;
drop function if exists public.enforce_balanced_ledger_postings();

-- 3. Record trigger function (row-level, security definer)
create or replace function public.record_ledger_balance_pending()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_txid xid8;
begin
  v_txid := pg_current_xact_id();

  if tg_op = 'INSERT' then
    insert into public.ledger_balance_pending (txid, transaction_id, transfer_id)
    values (v_txid, new.transaction_id, new.transfer_id)
    on conflict (txid, transaction_id, transfer_id) do nothing;
  elsif tg_op = 'DELETE' then
    insert into public.ledger_balance_pending (txid, transaction_id, transfer_id)
    values (v_txid, old.transaction_id, old.transfer_id)
    on conflict (txid, transaction_id, transfer_id) do nothing;
  elsif tg_op = 'UPDATE' then
    insert into public.ledger_balance_pending (txid, transaction_id, transfer_id)
    values (v_txid, new.transaction_id, new.transfer_id)
    on conflict (txid, transaction_id, transfer_id) do nothing;

    if old.transaction_id is distinct from new.transaction_id
       or old.transfer_id is distinct from new.transfer_id then
      insert into public.ledger_balance_pending (txid, transaction_id, transfer_id)
      values (v_txid, old.transaction_id, old.transfer_id)
      on conflict (txid, transaction_id, transfer_id) do nothing;
    end if;
  end if;

  return null;
end;
$$;

-- 4. Set-based deferred balance verification function (security definer)
create or replace function public.enforce_ledger_balance_pending()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_txid xid8;
begin
  v_txid := pg_current_xact_id();

  -- First firing checks all recorded parents for this transaction and deletes the rows.
  -- Subsequent firings within the same transaction find no rows and exit immediately.
  if not exists (
    select 1
    from public.ledger_balance_pending
    where txid = v_txid
  ) then
    return null;
  end if;

  -- Maintain an in-transaction counter for testability / verification proof
  perform set_config(
    'app.ledger_balance_check_invocations',
    (coalesce(nullif(current_setting('app.ledger_balance_check_invocations', true), '')::int, 0) + 1)::text,
    false
  );

  -- Set-based check for all affected parents in this transaction.
  -- UNION ALL over transaction_id and transfer_id allows using the respective
  -- parent indexes on public.ledger_postings.
  if exists (
    with current_parents as (
      select transaction_id, transfer_id
      from public.ledger_balance_pending
      where txid = v_txid
    ),
    affected_postings as (
      select p.transaction_id as parent_id, 'transaction' as parent_kind, p.currency, p.amount_minor
      from public.ledger_postings p
      join current_parents cp on p.transaction_id = cp.transaction_id
      where cp.transaction_id is not null
      union all
      select p.transfer_id as parent_id, 'transfer' as parent_kind, p.currency, p.amount_minor
      from public.ledger_postings p
      join current_parents cp on p.transfer_id = cp.transfer_id
      where cp.transfer_id is not null
    )
    select 1
    from affected_postings ap
    group by ap.parent_id, ap.parent_kind, ap.currency
    having sum(ap.amount_minor) <> 0
        or count(*) < 2
  ) then
    raise exception 'ledger postings must balance to zero per currency'
      using errcode = 'check_violation';
  end if;

  -- Delete pending rows for this transaction so subsequent firings are no-ops
  -- and the bookkeeping table is empty at commit.
  delete from public.ledger_balance_pending
  where txid = v_txid;

  return null;
end;
$$;

-- RULING 13 grant/revoke pair for ownership transfer
grant usage, create on schema public to savia_elevated;
alter function public.record_ledger_balance_pending() owner to savia_elevated;
alter function public.enforce_ledger_balance_pending() owner to savia_elevated;
revoke create on schema public from savia_elevated;

revoke execute on function public.record_ledger_balance_pending() from public;
revoke execute on function public.enforce_ledger_balance_pending() from public;

-- Attach row trigger to public.ledger_postings
create trigger record_ledger_balance_pending_from_posting
  after insert or update or delete on public.ledger_postings
  for each row execute function public.record_ledger_balance_pending();

-- Attach deferred constraint trigger to public.ledger_balance_pending
create constraint trigger enforce_ledger_balance_pending_trigger
  after insert or update on public.ledger_balance_pending
  deferrable initially deferred
  for each row execute function public.enforce_ledger_balance_pending();

commit;
