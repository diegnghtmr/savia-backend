begin;

-- Epica 4 slice 5: public.subscriptions table.
--
-- RULING 62: This slice delivers the table and the read path only.
-- There is no create/update endpoint for subscriptions in the contract; they are "detected".
-- No detection job exists yet and this slice does NOT write one.
--
-- Architectural Decisions:
-- D1. Workspace-scoped table: public.subscriptions.
--     Uses `workspace_id uuid not null references public.workspaces(id) on delete cascade`,
--     matching the house convention.
--     Carries `constraint subscriptions_workspace_id_id_key unique (workspace_id, id)`
--     for future composite foreign keys.
--
-- D2. Payee name denormalisation:
--     `payee_name text not null` is stored directly on the subscription record (denormalised).
--     The OpenAPI contract declares `payeeName: string` and contains no `payeeId`.
--     Subscriptions are detected from transaction statement patterns where merchant/payee text
--     descriptors exist independently of whether the user has created an entry in `public.payees`.
--     Names are constrained to between 1 and 120 characters via length CHECK constraint.
--
-- D3. Money storage and previous amount completeness invariant:
--     `current_amount_minor bigint not null`, `current_currency char(3) not null`.
--     `previous_amount_minor bigint`, `previous_currency char(3)`.
--     Enforced with CHECK constraint `subscriptions_previous_amount_complete_check`:
--     both previous_amount_minor and previous_currency must be NULL or both must be NOT NULL.
--
-- D4. RULING 59 / RULING 60 (increasePercent):
--     `increasePercent` is computed at read time from current and previous amounts, never stored.
--
-- D5. Status enum check:
--     `status text not null` constrained by `subscriptions_status_check`
--     to in ('detected', 'confirmed', 'ignored', 'cancelled').
--
-- D6. RLS and Grants:
--     Reads permitted for active workspace members (owner, administrator, editor, viewer).
--     Inserts and updates permitted for active owner, administrator, editor.
--     Inserts bind `created_by` to `app.subject_id`.
--     No DELETE privilege or policy: subscriptions are soft-managed, never hard-deleted.

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  payee_name text not null
    constraint subscriptions_payee_name_length_check
    check (length(payee_name) >= 1 and length(payee_name) <= 120),
  current_amount_minor bigint not null,
  current_currency char(3) not null
    constraint subscriptions_current_currency_format_check
    check (current_currency ~ '^[A-Z]{3}$'),
  previous_amount_minor bigint,
  previous_currency char(3)
    constraint subscriptions_previous_currency_format_check
    check (previous_currency is null or previous_currency ~ '^[A-Z]{3}$'),
  frequency text not null
    constraint subscriptions_frequency_length_check
    check (length(frequency) >= 1 and length(frequency) <= 120),
  next_expected_at timestamptz,
  status text not null
    constraint subscriptions_status_check
    check (status in ('detected', 'confirmed', 'ignored', 'cancelled')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint subscriptions_workspace_id_id_key
    unique (workspace_id, id),
  constraint subscriptions_previous_amount_complete_check
    check (
      (previous_amount_minor is null and previous_currency is null)
      or (previous_amount_minor is not null and previous_currency is not null)
    )
);

create index subscriptions_created_by_idx
  on public.subscriptions (created_by);

create index subscriptions_workspace_created_at_idx
  on public.subscriptions (workspace_id, created_at, id);

create index subscriptions_workspace_status_created_at_idx
  on public.subscriptions (workspace_id, status, created_at, id);

comment on table public.subscriptions is 'Workspace subscriptions. RULING 62: table and read path only. RULING 59: increasePercent computed.';

-- Row Level Security
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;

-- Grants: COLUMN-SCOPED insert and update grants for least privilege.
-- workspace_id, created_by, created_at, and id are immutable after insertion.
-- No delete privileges exist.
grant select on public.subscriptions to savia_application;
grant insert (
  workspace_id,
  payee_name,
  current_amount_minor,
  current_currency,
  previous_amount_minor,
  previous_currency,
  frequency,
  next_expected_at,
  status,
  created_by
) on public.subscriptions to savia_application;
grant update (
  payee_name,
  current_amount_minor,
  current_currency,
  previous_amount_minor,
  previous_currency,
  frequency,
  next_expected_at,
  status
) on public.subscriptions to savia_application;

-- Policies routed through public.workspace_actor_active_role helper.
create policy application_reads_workspace_subscriptions
  on public.subscriptions
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(subscriptions.workspace_id)
      in ('owner', 'administrator', 'editor', 'viewer')
  );

create policy application_inserts_workspace_subscriptions
  on public.subscriptions
  for insert
  to savia_application
  with check (
    public.workspace_actor_active_role(subscriptions.workspace_id)
      in ('owner', 'administrator', 'editor')
    and subscriptions.created_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_workspace_subscriptions
  on public.subscriptions
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(subscriptions.workspace_id)
      in ('owner', 'administrator', 'editor')
  )
  with check (
    public.workspace_actor_active_role(subscriptions.workspace_id)
      in ('owner', 'administrator', 'editor')
  );

commit;
