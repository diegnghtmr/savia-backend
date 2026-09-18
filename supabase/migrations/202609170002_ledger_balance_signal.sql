begin;

-- Finding 1 (round 2): Split ledger balance verification into a detail table (public.ledger_balance_pending)
-- and a single-row-per-transaction signal table (public.ledger_balance_signal).
--
-- In 202609170001, the deferred constraint trigger was attached to public.ledger_balance_pending
-- FOR EACH ROW. For a maximum import touching 10,000 distinct parents, PostgreSQL queued 10,000
-- deferred trigger invocations at COMMIT. Even though the first call cleared pending rows, PostgreSQL
-- still executed 9,999 no-op trigger evaluations, causing multi-second COMMIT and teardown latency.
--
-- The one-signal design:
-- 1. Keeps public.ledger_balance_pending as the detail table storing touched parent keys.
-- 2. Drops the row-level constraint trigger from public.ledger_balance_pending.
-- 3. Creates public.ledger_balance_signal (txid xid8 primary key), unlogged, forced RLS, no grants to application.
-- 4. public.record_ledger_balance_pending() records parents into detail table AND inserts (pg_current_xact_id())
--    into public.ledger_balance_signal ON CONFLICT (txid) DO NOTHING.
--    Only the first posting of the transaction inserts a signal row, queuing exactly ONE deferred trigger event.
-- 5. The deferred constraint trigger moves to public.ledger_balance_signal (AFTER INSERT ... DEFERRABLE INITIALLY DEFERRED).
-- 6. public.enforce_ledger_balance_pending() executes one set-based balance query over recorded parents,
--    raises check_violation if unbalanced, deletes recorded rows from both tables, and removes test GUC state.
--    If forced early firing occurs (SET CONSTRAINTS ... IMMEDIATE), the signal row is deleted; subsequent postings
--    re-insert the signal row, queuing a fresh deferred check at COMMIT.

-- 1. Remove constraint trigger from detail table
drop trigger if exists enforce_ledger_balance_pending_trigger on public.ledger_balance_pending;

-- 2. Signal table
create unlogged table public.ledger_balance_signal (
  txid xid8 primary key
);

comment on table public.ledger_balance_signal is
  'Transaction-scoped signal queue for deferred ledger balance verification at commit.';

alter table public.ledger_balance_signal enable row level security;
alter table public.ledger_balance_signal force row level security;

revoke all on public.ledger_balance_signal from public;

grant select, insert, delete on public.ledger_balance_signal to savia_elevated;

create policy elevated_manages_ledger_balance_signal
  on public.ledger_balance_signal
  for all
  to savia_elevated
  using (true)
  with check (true);

-- 3. Updated record trigger function (row-level, security definer)
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

  insert into public.ledger_balance_signal (txid)
  values (v_txid)
  on conflict (txid) do nothing;

  return null;
end;
$$;

-- 4. Updated set-based deferred balance verification function (security definer, no test GUC)
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

  if not exists (
    select 1
    from public.ledger_balance_pending
    where txid = v_txid
  ) then
    delete from public.ledger_balance_signal
    where txid = v_txid;
    return null;
  end if;

  -- Set-based check for all affected parents in this transaction.
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

  delete from public.ledger_balance_pending
  where txid = v_txid;

  delete from public.ledger_balance_signal
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

-- 5. Attach deferred constraint trigger to signal table
create constraint trigger enforce_ledger_balance_pending_trigger
  after insert on public.ledger_balance_signal
  deferrable initially deferred
  for each row execute function public.enforce_ledger_balance_pending();

commit;
