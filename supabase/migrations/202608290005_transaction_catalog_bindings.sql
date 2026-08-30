begin;

-- Epica 4 slice 6 (FINAL): close RULING 44 and bind transactions to category and payee catalogs.
--
-- Architectural Decisions:
-- D1. Prerequisite composite unique key on public.payees:
--     A composite foreign key requires a matching unique constraint on the referenced table.
--     public.categories already carries `categories_workspace_id_id_key unique (workspace_id, id)`.
--     public.payees only carried `payees_workspace_id_name_key unique (workspace_id, name)`.
--     Therefore, `payees_workspace_id_id_key unique (workspace_id, id)` is added first.
--
-- D2. Composite foreign keys on public.transactions (RULING 44 / RULING 48):
--     `transactions.category_id` and `transactions.payee_id` were previously plain nullable uuid columns.
--     Composite foreign keys `(workspace_id, category_id) references public.categories (workspace_id, id)`
--     and `(workspace_id, payee_id) references public.payees (workspace_id, id)` ensure category and
--     payee references belong to the same workspace, eliminating cross-workspace poison rows.
--
-- D3. ON DELETE RESTRICT:
--     The catalog tables (categories, payees) have no delete grant and no delete policy in RLS;
--     rows are archived (soft deletion), never hard-deleted. `on delete restrict` reflects this at
--     the schema level and preserves transaction referential integrity against out-of-band deletes.
--
-- D4. Nullable references preserved (MATCH SIMPLE):
--     Both `category_id` and `payee_id` remain nullable on `public.transactions`. Under PostgreSQL's
--     default MATCH SIMPLE semantics, a composite foreign key where any component is NULL is not
--     enforced, allowing uncategorized or payee-less transactions to exist cleanly.
--
-- D5. RULING 63 — Orphan rows must abort the migration, never be silently nulled:
--     Before adding constraints, we count any existing rows in `public.transactions` where `category_id`
--     or `payee_id` is non-null but has no matching row in `public.categories` or `public.payees` with
--     the identical `workspace_id`. If any orphan rows exist, we raise an exception to abort the migration
--     with a clear count, preventing silent data loss or destructive nullification.
--
-- D6. Referencing-side partial indexes on composite foreign keys:
--     PostgreSQL indexes the referenced unique keys automatically, but never the referencing columns.
--     Partial indexes `transactions_workspace_category_idx` and `transactions_workspace_payee_idx`
--     support referential integrity checks and catalog filtering without indexing nulls.

-- 1. Prerequisite: add composite unique constraint on public.payees (workspace_id, id)
alter table public.payees
  add constraint payees_workspace_id_id_key unique (workspace_id, id);

-- 2. RULING 63: Guard against orphan category_id references before adding FK
do $$
declare
  v_orphan_count integer;
begin
  select count(*) into v_orphan_count
    from public.transactions t
   where t.category_id is not null
     and not exists (
       select 1
         from public.categories c
        where c.workspace_id = t.workspace_id
          and c.id = t.category_id
     );

  if v_orphan_count > 0 then
    raise exception 'RULING 63 violation: found % orphan transaction row(s) with invalid category_id referencing nonexistent or cross-workspace categories; migration aborted',
      v_orphan_count;
  end if;
end;
$$;

-- 3. Add composite foreign key constraint for category_id
alter table public.transactions
  add constraint transactions_category_workspace_fkey
  foreign key (workspace_id, category_id)
  references public.categories (workspace_id, id)
  on delete restrict;

-- 4. RULING 63: Guard against orphan payee_id references before adding FK
do $$
declare
  v_orphan_count integer;
begin
  select count(*) into v_orphan_count
    from public.transactions t
   where t.payee_id is not null
     and not exists (
       select 1
         from public.payees p
        where p.workspace_id = t.workspace_id
          and p.id = t.payee_id
     );

  if v_orphan_count > 0 then
    raise exception 'RULING 63 violation: found % orphan transaction row(s) with invalid payee_id referencing nonexistent or cross-workspace payees; migration aborted',
      v_orphan_count;
  end if;
end;
$$;

-- 5. Add composite foreign key constraint for payee_id
alter table public.transactions
  add constraint transactions_payee_workspace_fkey
  foreign key (workspace_id, payee_id)
  references public.payees (workspace_id, id)
  on delete restrict;

-- 6. Add partial indexes on referencing columns (workspace_id, category_id) and (workspace_id, payee_id)
create index transactions_workspace_category_idx on public.transactions (workspace_id, category_id) where category_id is not null;
create index transactions_workspace_payee_idx    on public.transactions (workspace_id, payee_id)    where payee_id    is not null;

commit;
