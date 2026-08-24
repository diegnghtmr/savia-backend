begin;

alter table public.command_idempotency_records
  add column workspace_id uuid references public.workspaces(id) on delete cascade;

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
