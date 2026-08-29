begin;

-- Epica 3 slice 4a: relax account currency workspace invariant and require exchange rates.
--
-- Rate semantics (D1):
-- `rate` means how many units of `quoteCurrency` equal ONE unit of `baseCurrency`.
-- Standard convention: EUR/USD = 1.08 means 1 EUR = 1.08 USD.
-- So converting an EUR account into a USD-based workspace needs a row with
-- `base_currency = 'EUR'` and `quote_currency = 'USD'`.
--
-- Replacement invariant (D2):
-- Drop C6's two triggers and their two functions (202608240006_account_currency_invariant.sql),
-- and install a weaker one: an account may have currency <> workspace.base_currency ONLY IF
-- at least one exchange_rates row already exists for that pair in that workspace
-- (base_currency = the account's currency, quote_currency = the workspace's base currency).
-- An account whose currency EQUALS the base currency needs no rate.
--
-- Rationale:
-- ConvertedMoney in the contract requires rate, rateDate and rateSource as non-nullable,
-- and getAccountBalance declares only 200/401/403/404. With no rate there is no honest
-- answer available — the field cannot be omitted, the rate cannot be null, and inventing
-- an error status would diverge from the contract. Requiring the rate up front keeps
-- every balance answerable.
--
-- Important property:
-- exchange_rates is APPEND-ONLY (no UPDATE or DELETE grant), so once this invariant
-- is satisfied it can never later be broken by a rate disappearing. The invariant is monotonic.

-- 1. Validate existing data before installing triggers: refuse to apply against dirty data.
do $$
begin
  if exists (
    select 1
    from public.accounts account
    join public.workspaces workspace on workspace.id = account.workspace_id
    where account.currency <> workspace.base_currency
      and not exists (
        select 1
        from public.exchange_rates rate
        where rate.workspace_id = account.workspace_id
          and rate.base_currency = account.currency
          and rate.quote_currency = workspace.base_currency
      )
  ) then
    raise exception 'existing account currency violates workspace exchange rate invariant';
  end if;
end;
$$;

-- 2. Drop C6's triggers and functions from 202608240006
drop trigger if exists enforce_account_currency_matches_workspace_trigger on public.accounts;
drop trigger if exists enforce_workspace_base_currency_account_invariant_trigger on public.workspaces;
drop function if exists public.enforce_account_currency_matches_workspace();
drop function if exists public.enforce_workspace_base_currency_account_invariant();

-- 3. savia_elevated grants and policies for RLS bypass.
-- public.exchange_rates FORCEs row level security, so savia_elevated (a nobypassrls role)
-- needs an explicit select policy to read public.exchange_rates in security-definer triggers.
grant select on public.exchange_rates to savia_elevated;

create policy elevated_reads_exchange_rates
  on public.exchange_rates
  for select
  to savia_elevated
  using (true);

-- 4. Trigger on public.accounts
grant usage, create on schema public to savia_elevated;   -- revoked below (RULING 13)

create function public.enforce_account_currency_has_exchange_rate()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_base_currency text;
begin
  -- Serialize on the workspace advisory lock to prevent write skew between
  -- concurrent account inserts and rate inserts.
  -- Key derivation hashtextextended(new.workspace_id::text, 0) deliberately matches
  -- the application-level locks (readWorkspaceBaseCurrency and hasAccounts) so all four
  -- paths serialize on one key.
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));

  select workspace.base_currency into v_base_currency
    from public.workspaces workspace
   where workspace.id = new.workspace_id;

  if v_base_currency is not null and new.currency <> v_base_currency then
    if not exists (
      select 1
      from public.exchange_rates rate
      where rate.workspace_id = new.workspace_id
        and rate.base_currency = new.currency
        and rate.quote_currency = v_base_currency
    ) then
      -- The constraint name is carried explicitly so the application can map THIS
      -- violation to a 422 currency outcome, instead of letting a bare 23514 surface
      -- as a 500. Matching on the message text would be brittle.
      raise exception 'exchange rate required for account currency differing from workspace base currency'
        using errcode = 'check_violation',
              constraint = 'accounts_currency_requires_exchange_rate';
    end if;
  end if;

  return new;
end;
$$;

alter function public.enforce_account_currency_has_exchange_rate() owner to savia_elevated;

-- The account-side trigger alone leaves the invariant breakable from the OTHER
-- direction. Dropping the old workspace trigger above removed the database's
-- refusal to change base_currency, leaving that rule only in WorkspaceService.
-- Changing base_currency can strand every existing account whose currency has no
-- rate against the NEW base, and getAccountBalance would then throw for accounts
-- that were perfectly valid when they were created.
--
-- The old trigger refused any base_currency change while differing accounts
-- existed. This one enforces the weaker rule that matches the relaxed invariant:
-- the change is allowed as long as every account remains convertible afterwards.
create function public.enforce_workspace_base_currency_keeps_accounts_convertible()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Same key derivation as the account-side trigger and the application locks, so
  -- all paths serialize on one key. Without it, a concurrent account insert and a
  -- base_currency update could each observe a state the other is about to invalidate.
  perform pg_advisory_xact_lock(hashtextextended(new.id::text, 0));

  if exists (
    select 1
    from public.accounts account
    where account.workspace_id = new.id
      and account.currency <> new.base_currency
      and not exists (
        select 1
        from public.exchange_rates rate
        where rate.workspace_id = new.id
          and rate.base_currency = account.currency
          and rate.quote_currency = new.base_currency
      )
  ) then
    raise exception 'workspace base currency cannot change while accounts would be left without an exchange rate'
      using errcode = 'check_violation',
            constraint = 'workspace_base_currency_keeps_accounts_convertible';
  end if;

  return new;
end;
$$;

alter function public.enforce_workspace_base_currency_keeps_accounts_convertible()
  owner to savia_elevated;

-- Immediately after the ownership transfers, never later (RULING 13).
revoke create on schema public from savia_elevated;

-- Trigger-only helpers: no direct execute path needs them from PUBLIC.
revoke execute on function public.enforce_account_currency_has_exchange_rate() from public;
revoke execute on function public.enforce_workspace_base_currency_keeps_accounts_convertible() from public;

create trigger enforce_account_currency_has_exchange_rate_trigger
before insert or update of currency, workspace_id on public.accounts
for each row execute function public.enforce_account_currency_has_exchange_rate();

create trigger enforce_workspace_base_currency_keeps_accounts_convertible_trigger
before update of base_currency on public.workspaces
for each row execute function public.enforce_workspace_base_currency_keeps_accounts_convertible();

commit;
