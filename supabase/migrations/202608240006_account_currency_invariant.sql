begin;

-- Epica 2 corrective slice: database-level enforcement of the account currency
-- invariant (RULING 40).
--
-- RULING 40 requires that an account's currency equal its workspace's base
-- currency. This invariant is foundational for financial reporting (e.g.
-- getAccountBalance reporting rate: "1" with rateSource: "identity").
--
-- Prior to this migration, the invariant was enforced only in the application layer:
-- - AccountsService.create refused mismatched currencies with 422
-- - WorkspaceService.update refused base currency changes while accounts exist with 422
--
-- CHECK constraints cannot reference foreign tables in PostgreSQL, so database
-- enforcement requires security definer triggers on both public.accounts and
-- public.workspaces.

-- 1. Validate existing data before installing triggers: refuse to apply against dirty data.
do $$
begin
  if exists (
    select 1
    from public.accounts account
    join public.workspaces workspace on workspace.id = account.workspace_id
    where account.currency <> workspace.base_currency
  ) then
    raise exception 'existing account currency violates workspace base currency invariant';
  end if;
end;
$$;

-- 2. savia_elevated grants and policies for RLS bypass.
-- public.accounts FORCEs row level security, so savia_elevated (a nobypassrls role)
-- needs an explicit select policy to read public.accounts in security-definer triggers.
grant select on public.accounts to savia_elevated;
grant select on public.workspaces to savia_elevated;

create policy elevated_reads_accounts
  on public.accounts
  for select
  to savia_elevated
  using (true);

-- 3. Trigger on public.accounts
--
-- security definer here is defense in depth:
-- Under the policies installed today (202607150006_workspace_active_membership.sql
-- letting active members select workspaces, and 202608240002_account_tables.sql
-- requiring active role owner/admin/editor to insert accounts), every actor
-- authorized to insert or update an account is an active member and can read that
-- workspace row. Under the policies as installed today, an invoker-rights function
-- would NOT be blind for authorized writers.
--
-- Security definer decouples this foundational data-integrity check from visibility
-- policies that might be narrowed later, ensuring correct invariant enforcement for
-- any future role or maintenance path whose visibility does not already cover the
-- compared workspace row.
grant usage, create on schema public to savia_elevated;   -- revoked below (RULING 13)

create function public.enforce_account_currency_matches_workspace()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_base_currency text;
begin
  -- Serialize on the workspace advisory lock to prevent write skew between
  -- concurrent account inserts and workspace base_currency updates.
  -- Schedule: Tx A inserts USD account, reads base_currency 'USD', passes;
  -- Tx B concurrently updates base_currency to 'EUR', scans accounts, sees nothing, passes;
  -- both commit -> USD account in EUR workspace.
  -- Key derivation hashtextextended(new.workspace_id::text, 0) deliberately matches
  -- the application-level locks (readWorkspaceBaseCurrency and hasAccounts) so all four
  -- paths serialize on one key.
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));

  select workspace.base_currency into v_base_currency
    from public.workspaces workspace
   where workspace.id = new.workspace_id;

  if v_base_currency is not null and new.currency <> v_base_currency then
    raise exception 'account currency must match workspace base currency'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

alter function public.enforce_account_currency_matches_workspace() owner to savia_elevated;

-- 4. Trigger on public.workspaces
--
-- security definer here is likewise defense in depth:
-- Under the policies installed today, owners and administrators authorized to update
-- base_currency are active members who can read that workspace's accounts. An
-- invoker-rights function would NOT be blind for authorized writers today.
--
-- Running with security definer decouples the invariant check from account visibility
-- policies, keeping enforcement robust against future policy changes or specialized roles.
create function public.enforce_workspace_base_currency_account_invariant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Serialize on the workspace advisory lock to prevent write skew between
  -- concurrent account inserts and workspace base_currency updates.
  -- Schedule: Tx A inserts USD account, reads base_currency 'USD', passes;
  -- Tx B concurrently updates base_currency to 'EUR', scans accounts, sees nothing, passes;
  -- both commit -> USD account in EUR workspace.
  -- Key derivation hashtextextended(new.id::text, 0) deliberately matches
  -- the application-level locks (readWorkspaceBaseCurrency and hasAccounts) so all four
  -- paths serialize on one key.
  perform pg_advisory_xact_lock(hashtextextended(new.id::text, 0));

  if exists (
    select 1
    from public.accounts account
    where account.workspace_id = new.id
      and account.currency <> new.base_currency
  ) then
    raise exception 'workspace base currency cannot change while accounts with differing currencies exist'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

alter function public.enforce_workspace_base_currency_account_invariant() owner to savia_elevated;

-- Immediately after the ownership transfers, never later (RULING 13).
revoke create on schema public from savia_elevated;

-- Trigger-only helpers: no direct execute path needs them from PUBLIC.
revoke execute on function public.enforce_account_currency_matches_workspace() from public;
revoke execute on function public.enforce_workspace_base_currency_account_invariant() from public;

create trigger enforce_account_currency_matches_workspace_trigger
before insert or update of currency, workspace_id on public.accounts
for each row execute function public.enforce_account_currency_matches_workspace();

create trigger enforce_workspace_base_currency_account_invariant_trigger
before update of base_currency on public.workspaces
for each row execute function public.enforce_workspace_base_currency_account_invariant();

commit;
