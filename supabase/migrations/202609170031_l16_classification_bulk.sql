begin;

alter table public.categories add column if not exists essential boolean not null default false;
alter table public.transactions
  add column if not exists archived boolean not null default false,
  add column if not exists excluded_from_reports boolean not null default false,
  add column if not exists extraordinary boolean not null default false;

grant insert (essential) on public.categories to savia_application;
grant update (archived, excluded_from_reports, extraordinary, type) on public.transactions to savia_application;

-- Preserve the immutable booked amount, posting pair and import provenance.
-- A column-scoped grant alone would also allow unrelated type transitions.
create function public.guard_imported_transaction_conversion() returns trigger
language plpgsql set search_path = pg_catalog
as $$
begin
  if not (
    old.type = 'adjustment' and old.import_job_id is not null
    and new.import_job_id is not distinct from old.import_job_id
    and old.status not in ('reconciled', 'voided')
    and new.status = old.status and new.occurred_at = old.occurred_at
    and ((new.type = 'income' and old.amount_minor > 0)
      or (new.type = 'expense' and old.amount_minor < 0))
  ) then
    raise exception 'Only imported adjustments with a compatible amount may be converted.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger guard_imported_transaction_conversion
  before update of type on public.transactions
  for each row when (old.type is distinct from new.type)
  execute function public.guard_imported_transaction_conversion();

commit;
