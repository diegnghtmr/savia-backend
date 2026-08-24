begin;

-- RULING 47 (binding): workspace_id is a scoping discriminator, NOT a referential
-- link -- it carries no foreign key. An idempotency record is about the COMMAND and
-- must outlive the resource whose deletion it records: WorkspaceService.delete()
-- removes the workspaces row and then writes this record in the same transaction,
-- so any FK raises 23503 there, and reordering cannot help because cascade would
-- destroy the record that answers the replay. The value is server-derived from the
-- authenticated request, never client-supplied; orphans are bounded by the
-- adapter's created_at > now() - interval '24 hours' read filter.
alter table public.command_idempotency_records
  add column workspace_id uuid;

-- STRICT lookup: a plain SELECT ... INTO caps retrieval at one row, so ROW_COUNT
-- can never exceed 1 and a `<> 1` guard only ever catches the zero case -- with
-- two unique constraints the old guard passed and dropped an arbitrary one.
-- STRICT raises NO_DATA_FOUND (P0002) on zero and TOO_MANY_ROWS (P0003) on more
-- than one, making both the silent-additive outcomes impossible.
do $$
declare
  v_constraint_name text;
begin
  begin
    select conname into strict v_constraint_name
    from pg_constraint
    where conrelid = 'public.command_idempotency_records'::regclass
      and contype = 'u';
  exception
    when no_data_found then
      raise exception 'Expected exactly 1 unique constraint on command_idempotency_records, found 0';
    when too_many_rows then
      raise exception 'Expected exactly 1 unique constraint on command_idempotency_records, found more than 1; refusing to guess which to drop';
  end;

  execute format('alter table public.command_idempotency_records drop constraint %I', v_constraint_name);
end $$;

alter table public.command_idempotency_records
  add unique nulls not distinct (subject_id, route, idempotency_key, workspace_id);

commit;
