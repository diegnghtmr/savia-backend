begin;

create table public.recurring_occurrences (
  id uuid primary key,
  workspace_id uuid not null,
  rule_id uuid not null,
  scheduled_at timestamptz not null,
  behavior text not null check (behavior in ('remind', 'create_draft', 'create_pending', 'confirm_automatically')),
  transaction_id uuid unique,
  unique (workspace_id, rule_id, scheduled_at),
  foreign key (workspace_id, rule_id) references public.recurring_rules (workspace_id, id) on delete cascade,
  foreign key (workspace_id, transaction_id) references public.transactions (workspace_id, id),
  check ((behavior = 'remind') = (transaction_id is null))
);

comment on table public.recurring_occurrences is 'Materialized recurring rule occurrences. fitness:financial';
alter table public.recurring_occurrences enable row level security;
alter table public.recurring_occurrences force row level security;
grant insert (id, workspace_id, rule_id, scheduled_at, behavior, transaction_id)
  on public.recurring_occurrences to savia_application;

create policy application_inserts_creator_occurrences
  on public.recurring_occurrences for insert to savia_application
  with check (
    public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    and exists (
      select 1 from public.recurring_rules r
      where r.workspace_id = recurring_occurrences.workspace_id
        and r.id = recurring_occurrences.rule_id
        and r.created_by = nullif(current_setting('app.subject_id', true), '')::uuid
        and r.active and r.next_occurrence_at = recurring_occurrences.scheduled_at
        and r.behavior = recurring_occurrences.behavior
    )
  );

commit;
