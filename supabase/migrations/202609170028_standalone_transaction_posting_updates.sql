begin;

create or replace function public.guard_occurrence_posting_date() returns trigger
language plpgsql set search_path = pg_catalog, public
as $$
begin
  if old.occurred_at is distinct from new.occurred_at and not (
    (
      old.status in ('draft', 'pending', 'confirmed')
      and new.status in ('draft', 'pending')
      and exists (
        select 1 from public.recurring_occurrences o
        join public.recurring_rules r on r.workspace_id = o.workspace_id and r.id = o.rule_id
        join public.transactions t on t.workspace_id = o.workspace_id and t.id = o.transaction_id
        where o.workspace_id = old.workspace_id and t.id = old.transaction_id
          and o.skipped_at is null
          and r.created_by = nullif(current_setting('app.subject_id', true), '')::uuid
          and t.status = new.status and t.occurred_at = new.occurred_at
      )
    ) or (
      -- A direct posting UPDATE has depth 1, even when targeting a date
      -- already present on a stale header. The header-trigger write is nested
      -- and its parent row must also be written by this transaction.
      pg_trigger_depth() = 2
      and old.status in ('draft', 'pending', 'confirmed')
      and new.status in ('draft', 'pending', 'confirmed')
      and exists (
        select 1 from public.transactions t
        where t.workspace_id = old.workspace_id and t.id = old.transaction_id
          and t.xmin = pg_current_xact_id()::xid
          and t.status = new.status and t.occurred_at = new.occurred_at
          and not exists (
            select 1 from public.recurring_occurrences o
            where o.workspace_id = t.workspace_id and o.transaction_id = t.id
          )
          and not exists (
            select 1 from public.transfers transfer
            where transfer.workspace_id = t.workspace_id and transfer.transaction_id = t.id
          )
      )
    )
  ) then
    raise exception 'Ledger posting date is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Invoker rights: the existing workspace RLS and column grants still apply.
-- A header edit and its pair succeed or roll back as a single statement.
create function public.align_standalone_transaction_postings() returns trigger
language plpgsql set search_path = pg_catalog, public
as $$
declare
  aligned bigint;
begin
  -- Keep recurring and transfer-owned postings outside standalone alignment.
  -- A transfer fee PATCH remains header-only, as it was in b143f90.
  if exists (
    select 1 from public.recurring_occurrences o
    where o.workspace_id = new.workspace_id and o.transaction_id = new.id
  ) or exists (
    select 1 from public.transfers transfer
    where transfer.workspace_id = new.workspace_id and transfer.transaction_id = new.id
  ) then
    return null;
  end if;

  update public.ledger_postings p
     set status = new.status, occurred_at = new.occurred_at
   where p.workspace_id = new.workspace_id and p.transaction_id = new.id
     and p.status in ('draft', 'pending', 'confirmed');
  get diagnostics aligned = row_count;
  if aligned <> 2 then
    raise exception 'Standalone transaction posting pair was not aligned.'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create trigger align_standalone_transaction_postings
  after update of status, occurred_at on public.transactions
  for each row when (
    old.status in ('draft', 'pending', 'confirmed')
    and new.status in ('draft', 'pending', 'confirmed')
    and (old.status is distinct from new.status or old.occurred_at is distinct from new.occurred_at)
  ) execute function public.align_standalone_transaction_postings();

commit;
