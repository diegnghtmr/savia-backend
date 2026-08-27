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
-- security definer here is LOAD-BEARING, not decoration:
-- public.workspaces carries FORCE row level security. As an invoker-rights
-- function, the lookup of public.workspaces would execute under the writing
-- subject whose visibility is RLS-filtered. If the subject cannot read the
-- workspace row, the lookup would return NULL, making the currency comparison
-- silently vacuous and allowing mismatched account currencies to be inserted
-- or updated without error.
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
-- security definer here is likewise LOAD-BEARING:
-- public.accounts carries FORCE row level security. An invoker-rights function
-- scanning public.accounts would be filtered by the updating subject's RLS
-- context, potentially seeing zero accounts and silently permitting a base_currency
-- mutation that violates existing accounts' currency invariant.
create function public.enforce_workspace_base_currency_account_invariant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
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
