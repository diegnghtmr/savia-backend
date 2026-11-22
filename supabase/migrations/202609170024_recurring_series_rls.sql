begin;

-- Keep series changes and version updates under the creator's write role.
-- The worker already advances the rule cursor as the creator.
alter policy application_updates_workspace_recurring_rules
  on public.recurring_rules
  using (
    public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  )
  with check (
    public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  );

-- The editable booking is authoritative for the new state and date. Its
-- posting pair may still have an earlier status after standalone PATCH.
create or replace function public.guard_occurrence_posting_date() returns trigger
language plpgsql set search_path = pg_catalog, public
as $$
begin
  if old.occurred_at is distinct from new.occurred_at and not (
    old.status in ('draft', 'pending', 'confirmed')
    and new.status in ('draft', 'pending')
    and exists (
      select 1 from public.recurring_occurrences o
      join public.recurring_rules r on r.workspace_id = o.workspace_id and r.id = o.rule_id
      join public.transactions t on t.workspace_id = o.workspace_id and t.id = o.transaction_id
      where o.workspace_id = old.workspace_id and t.id = old.transaction_id
        and o.skipped_at is null
        and r.created_by = nullif(current_setting('app.subject_id', true), '')::uuid
        and t.status = new.status and t.occurred_at = new.occurred_at
    )
  ) then
    raise exception 'Ledger posting date is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

commit;
