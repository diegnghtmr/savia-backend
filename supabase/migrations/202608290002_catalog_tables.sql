begin;

-- Epica 4 slice 1: public.categories, public.tags, and public.payees catalog tables.
--
-- Catalog tables represent hierarchical categories, transaction tags, and payees
-- scoped to a workspace. The contract authority defines:
-- - Tag and Payee as NamedResource { id, name, archived }
-- - Category as NamedResource + { parentId, kind, icon, colorToken }
--
-- Architectural Decisions:
-- D1. Three workspace-scoped tables: public.categories, public.tags, public.payees.
--     All use `workspace_id uuid not null references public.workspaces(id) on delete cascade`,
--     matching the house convention for accounts, transfers, and exchange_rates.
--     Names are constrained to between 1 and 120 characters via length CHECK constraints.
--
-- D2. Composite foreign key for category self-reference (RULING 48):
--     A single-column `parent_id references categories(id)` would allow referencing a parent
--     category from ANOTHER workspace (the cross-workspace poison-row defect).
--     Therefore, `categories` carries `unique (workspace_id, id)` and the self-FK is composite:
--     `foreign key (workspace_id, parent_id) references public.categories (workspace_id, id)`.
--
-- D3. Name uniqueness:
--     - tags: `unique (workspace_id, name)`
--     - payees: `unique (workspace_id, name)`
--     - categories: sibling categories under the same parent must have unique names:
--       `unique (workspace_id, parent_id, name)`. Because PostgreSQL UNIQUE constraints
--       treat NULLs as distinct, top-level categories (parent_id is null) would not be
--       constrained by the composite key alone. A partial unique index
--       `unique (workspace_id, name) where parent_id is null` is added to enforce top-level uniqueness.
--
-- D4. No `fitness:financial` tag on these three tables:
--     They are metadata catalogs and hold no money or financial balances.
--     The fitness rule exists to force `workspace_id` on financial tables; these tables
--     carry `workspace_id` by construction.
--
-- D5. Deferred foreign keys on public.transactions (RULING 44):
--     Foreign keys from `public.transactions.category_id` and `payee_id` to these catalog tables
--     are chartered under RULING 44. Because modifying an existing financial table requires its own
--     isolated review and migration, that binding belongs in a subsequent PR.
--
-- D6. RLS and Grants:
--     Reads permitted for active workspace members (owner, administrator, editor, viewer).
--     Inserts and updates permitted for active owner, administrator, editor.
--     Inserts bind `created_by` to `app.subject_id`.
--     No DELETE privilege or policy: catalog items are archived, never hard-deleted.

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  parent_id uuid,
  name text not null
    constraint categories_name_length_check
    check (length(name) >= 1 and length(name) <= 120),
  kind text not null
    constraint categories_kind_check
    check (kind in ('income', 'expense', 'transfer', 'other')),
  icon text,
  color_token text,
  archived boolean not null default false,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  -- Composite unique key required for RULING 48 composite self-referential foreign key.
  constraint categories_workspace_id_id_key
    unique (workspace_id, id),
  -- RULING 48: Composite foreign key ensures parent category belongs to the same workspace,
  -- preventing cross-workspace poison-row defects.
  constraint categories_parent_workspace_fkey
    foreign key (workspace_id, parent_id)
    references public.categories (workspace_id, id)
    on delete restrict,
  -- Sibling categories under the same parent must have unique names within a workspace.
  constraint categories_workspace_parent_name_key
    unique (workspace_id, parent_id, name)
);

-- Partial unique index for top-level categories (where parent_id is null).
-- In PostgreSQL, UNIQUE constraints treat NULLs as distinct values. The composite constraint
-- (workspace_id, parent_id, name) alone would permit duplicate top-level category names.
-- This partial index guarantees top-level category name uniqueness per workspace.
create unique index categories_workspace_top_level_name_idx
  on public.categories (workspace_id, name)
  where parent_id is null;

create index categories_workspace_parent_idx
  on public.categories (workspace_id, parent_id);

create index categories_created_by_idx
  on public.categories (created_by);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null
    constraint tags_name_length_check
    check (length(name) >= 1 and length(name) <= 120),
  archived boolean not null default false,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint tags_workspace_id_name_key
    unique (workspace_id, name)
);

create index tags_created_by_idx
  on public.tags (created_by);

create table public.payees (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null
    constraint payees_name_length_check
    check (length(name) >= 1 and length(name) <= 120),
  archived boolean not null default false,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint payees_workspace_id_name_key
    unique (workspace_id, name)
);

create index payees_created_by_idx
  on public.payees (created_by);

-- Catalog tables hold metadata, not financial balances. They deliberately omit the
-- 'fitness:financial' comment tag while still carrying workspace_id.
comment on table public.categories is 'Workspace categories catalog.';
comment on table public.tags is 'Workspace transaction tags catalog.';
comment on table public.payees is 'Workspace transaction payees catalog.';

-- Row Level Security
alter table public.categories enable row level security;
alter table public.categories force row level security;

alter table public.tags enable row level security;
alter table public.tags force row level security;

alter table public.payees enable row level security;
alter table public.payees force row level security;

-- Grants: COLUMN-SCOPED insert and update grants for least privilege.
-- workspace_id, created_by, created_at, and id are immutable after insertion.
-- Catalog tables support archiving and updates, but NO delete privileges exist (soft archiving).
grant select on public.categories to savia_application;
grant insert (workspace_id, parent_id, name, kind, icon, color_token, archived, created_by)
  on public.categories to savia_application;
grant update (parent_id, name, kind, icon, color_token, archived)
  on public.categories to savia_application;

grant select on public.tags to savia_application;
grant insert (workspace_id, name, archived, created_by)
  on public.tags to savia_application;
grant update (name, archived)
  on public.tags to savia_application;

grant select on public.payees to savia_application;
grant insert (workspace_id, name, archived, created_by)
  on public.payees to savia_application;
grant update (name, archived)
  on public.payees to savia_application;

-- Policies routed through public.workspace_actor_active_role helper.
create policy application_reads_workspace_category
  on public.categories
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(categories.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_category
  on public.categories
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(categories.workspace_id)
      in ('owner', 'administrator', 'editor')
    and categories.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_workspace_category
  on public.categories
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(categories.workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(categories.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

create policy application_reads_workspace_tag
  on public.tags
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(tags.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_tag
  on public.tags
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(tags.workspace_id)
      in ('owner', 'administrator', 'editor')
    and tags.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_workspace_tag
  on public.tags
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(tags.workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(tags.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

create policy application_reads_workspace_payee
  on public.payees
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(payees.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_payee
  on public.payees
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(payees.workspace_id)
      in ('owner', 'administrator', 'editor')
    and payees.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_workspace_payee
  on public.payees
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(payees.workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(payees.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

-- savia_elevated select grant and policy for RLS bypass in security-definer trigger.
-- public.categories FORCEs row level security, so savia_elevated (a nobypassrls role)
-- needs an explicit select policy to read public.categories in security-definer triggers.
grant select on public.categories to savia_elevated;

create policy elevated_reads_categories
  on public.categories
  for select
  to savia_elevated
  using (true);

-- Category hierarchy cycle guard
grant usage, create on schema public to savia_elevated;   -- revoked below (RULING 13)

-- RULING 50: the category hierarchy has no depth limit by contract; only cycles are forbidden.
create function public.enforce_category_hierarchy_acyclic()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.id is not null and new.parent_id = new.id then
    raise exception 'category parent must not form a cycle'
      using errcode = 'check_violation',
            constraint = 'categories_parent_must_not_form_cycle';
  end if;

  -- Serialize on the workspace advisory lock to prevent write skew between concurrent updates.
  -- Follows the project lock-ordering convention: SUBJECT -> WORKSPACE -> ACCOUNT.
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));

  if exists (
    with recursive ancestors(id, parent_id) as (
      select c.id, c.parent_id
      from public.categories c
      where c.workspace_id = new.workspace_id
        and c.id = new.parent_id
      union all
      select c.id, c.parent_id
      from public.categories c
      join ancestors a on c.id = a.parent_id
      where c.workspace_id = new.workspace_id
    ) cycle id set is_cycle using path
    select 1
    from ancestors
    where id = new.id
  ) then
    raise exception 'category parent must not form a cycle'
      using errcode = 'check_violation',
            constraint = 'categories_parent_must_not_form_cycle';
  end if;

  return new;
end;
$$;

alter function public.enforce_category_hierarchy_acyclic() owner to savia_elevated;

-- Immediately after the ownership transfer, never later (RULING 13).
revoke create on schema public from savia_elevated;

-- Trigger-only helper: no direct execute path needs it.
revoke execute on function public.enforce_category_hierarchy_acyclic() from public;

create trigger enforce_category_hierarchy_acyclic_trigger
before insert or update of parent_id on public.categories
for each row execute function public.enforce_category_hierarchy_acyclic();

commit;
