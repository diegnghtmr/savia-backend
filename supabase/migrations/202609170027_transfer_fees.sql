begin;

-- A fee-less transfer still keeps its description without creating a ledger
-- transaction. Fee linkage uses the existing workspace-scoped foreign key.
alter table public.transfers
  add column description text check (char_length(description) <= 500);
grant insert (description) on public.transfers to savia_application;

commit;
