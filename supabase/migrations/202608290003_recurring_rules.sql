begin;

-- Epica 4 slice 4: public.recurring_rules table.
--
-- Recurring rules define recurring transaction automation and schedules scoped to a workspace.
--
-- Architectural Decisions:
-- D1. Workspace-scoped table: public.recurring_rules.
--     Uses `workspace_id uuid not null references public.workspaces(id) on delete cascade`,
--     matching the house convention.
--     Names are constrained to between 1 and 120 characters via length CHECK constraint.
--
-- D2. Composite foreign key for account reference (RULING 48 / RULING 53):
--     A single-column `account_id references accounts(id)` would permit referencing an account
--     from ANOTHER workspace (cross-workspace poison-row defect).
--     Therefore, `recurring_rules` carries composite foreign key:
--     `foreign key (workspace_id, account_id) references public.accounts (workspace_id, id) on delete restrict`.
--     `recurring_rules` also carries `unique (workspace_id, id)` for future composite FKs.
--
-- D3. Template storage:
--     `template` is stored as `jsonb not null` (validated at application boundary).
--     The anchor day-of-month is stored separately in `anchor_day_of_month` (RULING 54)
--     so clamping does not degrade the anchor across shorter months.
--
-- D4. Timezone and UTC arithmetic (RULING 56):
--     All timestamps are `timestamptz` and all occurrence arithmetic is evaluated in UTC.
--
-- D5. RLS and Grants:
--     Reads permitted for active workspace members (owner, administrator, editor, viewer).
--     Inserts and updates permitted for active owner, administrator, editor.
--     Inserts bind `created_by` to `app.subject_id`.
--     No DELETE privilege or policy: rules are deactivated/archived, never hard-deleted.

create table public.recurring_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null
    constraint recurring_rules_name_length_check
    check (length(name) >= 1 and length(name) <= 120),
  frequency text not null
    constraint recurring_rules_frequency_check
    check (frequency in ('daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom')),
  rrule text,
  behavior text not null
    constraint recurring_rules_behavior_check
    check (behavior in ('remind', 'create_draft', 'create_pending', 'confirm_automatically')),
  account_id uuid not null,
  template jsonb not null,
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  next_occurrence_at timestamptz not null,
  anchor_day_of_month smallint not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  -- Composite unique key required for future composite foreign keys
  constraint recurring_rules_workspace_id_id_key
    unique (workspace_id, id),
  -- RULING 48 / RULING 53: Composite foreign key ensures account belongs to the same workspace,
  -- preventing cross-workspace poison-row defects.
  constraint recurring_rules_account_workspace_fkey
    foreign key (workspace_id, account_id)
    references public.accounts (workspace_id, id)
    on delete restrict
);

create index recurring_rules_created_by_idx
  on public.recurring_rules (created_by);

create index recurring_rules_workspace_account_idx
  on public.recurring_rules (workspace_id, account_id);

create index recurring_rules_workspace_created_at_idx
  on public.recurring_rules (workspace_id, created_at, id);

create index recurring_rules_workspace_next_occurrence_idx
  on public.recurring_rules (workspace_id, next_occurrence_at);

comment on table public.recurring_rules is 'Workspace recurring transaction rules. RULING 56: timestamps and arithmetic in UTC.';

-- Row Level Security
alter table public.recurring_rules enable row level security;
alter table public.recurring_rules force row level security;

-- Grants: COLUMN-SCOPED insert and update grants for least privilege.
-- workspace_id, created_by, created_at, and id are immutable after insertion.
-- No delete privileges exist.
grant select on public.recurring_rules to savia_application;
grant insert (
  workspace_id,
  name,
  frequency,
  rrule,
  behavior,
  account_id,
  template,
  active,
  starts_at,
  ends_at,
  next_occurrence_at,
  anchor_day_of_month,
  created_by
) on public.recurring_rules to savia_application;
grant update (
  name,
  frequency,
  rrule,
  behavior,
  account_id,
  template,
  active,
  starts_at,
  ends_at,
  next_occurrence_at,
  anchor_day_of_month
) on public.recurring_rules to savia_application;

-- Policies routed through public.workspace_actor_active_role helper.
create policy application_reads_workspace_recurring_rules
  on public.recurring_rules
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(recurring_rules.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_recurring_rules
  on public.recurring_rules
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(recurring_rules.workspace_id)
      in ('owner', 'administrator', 'editor')
    and recurring_rules.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_workspace_recurring_rules
  on public.recurring_rules
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(recurring_rules.workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(recurring_rules.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

commit;
