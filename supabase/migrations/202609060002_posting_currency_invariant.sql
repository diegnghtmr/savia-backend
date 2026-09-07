begin;

-- Corrective slice: database-level enforcement of the posting-currency invariant.
--
-- public.ledger_postings.currency must match public.accounts.currency for every
-- account leg (leg_kind = 'account'). External legs (leg_kind = 'external') do not
-- carry an account_id and are exempt.
--
-- Prior to this migration, foreign-currency postings could be written to an account,
-- permanently breaking balance reporting (GET /v1/accounts/{id}/balance -> 500)
-- and silently corrupting analytics, scenarios, and forecasts.
--
-- CHECK constraints cannot reference foreign tables in PostgreSQL, so database
-- enforcement requires a security definer trigger on public.ledger_postings.

-- 1. Validate existing data before installing triggers: refuse to apply against dirty data.
do $$
begin
  if exists (
    select 1
    from public.ledger_postings posting
    join public.accounts account
      on account.id = posting.account_id
     and account.workspace_id = posting.workspace_id
    where posting.leg_kind = 'account'
      and posting.currency <> account.currency
  ) then
    raise exception 'existing ledger posting currency violates the account currency invariant';
  end if;
end;
$$;

-- 2. Trigger function on public.ledger_postings
--
-- security definer here is LOAD-BEARING, not decoration (precedent: 202608240005_ledger_postings.sql:178-185):
-- public.accounts FORCEs row level security, so an invoker-rights function would be
-- filtered by the writing subject's policies and could read no account row at all --
-- an invariant that silently passes while appearing to work.
-- savia_elevated already holds SELECT on public.accounts and policy elevated_reads_accounts
-- (installed by 202608240006_account_currency_invariant.sql:35-42).
--
-- Advisory lock ordering analysis:
-- Project convention (202608240006:78-92) is SUBJECT -> WORKSPACE -> ACCOUNT.
-- On the insert path, the caller already holds the account advisory lock (lockAndReadAccount).
-- We deliberately do NOT acquire any workspace advisory lock here:
-- 1. Taking a workspace lock while holding the account lock would invert the documented order
--    and risk deadlock.
-- 2. accounts.currency is immutable by grant (202608240002_account_tables.sql:69-71 grants update
--    on name, institution, masked_number, description, include_in_net_worth, status, closed_at,
--    updated_at, version, but NOT currency), so there is no concurrent writer to race against.
grant usage, create on schema public to savia_elevated;   -- revoked below (RULING 13)

create function public.enforce_ledger_posting_currency_matches_account()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_account_currency text;
begin
  -- External legs carry no account_id (guaranteed by ledger_postings_account_leg_parity_check)
  if new.leg_kind <> 'account' then
    return new;
  end if;

  select account.currency into v_account_currency
    from public.accounts account
   where account.workspace_id = new.workspace_id
     and account.id = new.account_id;

  -- A null account currency (e.g. account row not found) must raise, not pass.
  -- Treating "row not found / cannot see row" as success would be the exact failure
  -- mode that security definer exists to prevent.
  if v_account_currency is null or new.currency <> v_account_currency then
    raise exception 'ledger posting currency must match its account currency'
      using errcode = 'check_violation',
            constraint = 'ledger_postings_currency_matches_account';
  end if;

  return new;
end;
$$;

alter function public.enforce_ledger_posting_currency_matches_account() owner to savia_elevated;

-- Immediately after the ownership transfer, never later (RULING 13).
revoke create on schema public from savia_elevated;

-- Trigger-only helper: no direct execute path needs it from PUBLIC.
revoke execute on function public.enforce_ledger_posting_currency_matches_account() from public;

-- Trigger declaration:
-- before insert or update of currency, account_id, workspace_id on public.ledger_postings.
-- We include 'update of' even though 202608240005:117 grants savia_application update on status
-- only: the column-scoped grant closes the application path, while the trigger closes every
-- other role's path.
create trigger enforce_ledger_posting_currency_matches_account_trigger
before insert or update of currency, account_id, workspace_id on public.ledger_postings
for each row execute function public.enforce_ledger_posting_currency_matches_account();

commit;
