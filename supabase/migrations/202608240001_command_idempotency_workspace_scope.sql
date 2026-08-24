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

do $$
declare
  v_constraint_name text;
  v_count integer;
begin
  select conname into v_constraint_name
  from pg_constraint
  where conrelid = 'public.command_idempotency_records'::regclass
    and contype = 'u';

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'Expected exactly 1 unique constraint on command_idempotency_records, found %', v_count;
  end if;

  execute format('alter table public.command_idempotency_records drop constraint %I', v_constraint_name);
end $$;

alter table public.command_idempotency_records
  add unique nulls not distinct (subject_id, route, idempotency_key, workspace_id);

commit;
