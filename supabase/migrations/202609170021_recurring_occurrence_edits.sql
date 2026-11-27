begin;

alter table public.recurring_rules
  add column version integer not null default 1 check (version >= 1),
  add column series_changes jsonb not null default '[]';
grant update (version, series_changes) on public.recurring_rules to savia_application;

-- scheduled_at remains the original cadence slot. A non-materialized row stores
-- only per-slot overrides; it is detached from the main cursor when moved.
alter table public.recurring_occurrences
  add column effective_at timestamptz,
  add column materialized boolean not null default true,
  drop constraint recurring_occurrences_booking_check,
  add constraint recurring_occurrences_booking_check check (
    (not materialized and transaction_id is null and skipped_at is null)
    or (materialized and (skipped_at is not null or behavior = 'remind' or transaction_id is not null))
  );
create unique index recurring_occurrences_effective_slot_key on public.recurring_occurrences
  (workspace_id, rule_id, coalesce(effective_at, scheduled_at));
create index recurring_occurrences_detached_due_idx on public.recurring_occurrences
  (effective_at) where not materialized and effective_at is not null;
grant insert (effective_at, materialized, version) on public.recurring_occurrences to savia_application;
grant update (effective_at, materialized, template) on public.recurring_occurrences to savia_application;
-- Only the rule creator may align the date of a linked draft/pending posting
-- with its booking. Settled and unrelated posting dates stay immutable.
create function public.guard_occurrence_posting_date() returns trigger
language plpgsql set search_path = pg_catalog, public
as $$
begin
  if old.occurred_at is distinct from new.occurred_at and not (
    old.status in ('draft', 'pending') and new.status = old.status and exists (
      select 1 from public.recurring_occurrences o
      join public.recurring_rules r on r.workspace_id = o.workspace_id and r.id = o.rule_id
      join public.transactions t on t.workspace_id = o.workspace_id and t.id = o.transaction_id
      where o.workspace_id = old.workspace_id and t.id = old.transaction_id
        and r.created_by = nullif(current_setting('app.subject_id', true), '')::uuid
        and t.status = old.status and t.occurred_at = new.occurred_at
    )
  ) then
    raise exception 'Ledger posting date is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_occurrence_posting_date before update of occurred_at on public.ledger_postings
  for each row execute function public.guard_occurrence_posting_date();
grant update (occurred_at) on public.ledger_postings to savia_application;

-- Later boundaries override earlier ones per field; repeated boundaries are
-- resolved in acceptance order. Null is an explicit value, not an omission.
create function public.recurring_template_at(base jsonb, edits jsonb, slot timestamptz)
returns table (template jsonb, revision integer)
language sql stable set search_path = pg_catalog
as $$
  with applicable as (
    select entry, ordinality, (entry->>'effectiveFrom')::timestamptz as boundary
      from jsonb_array_elements(edits) with ordinality as e(entry, ordinality)
     where (entry->>'effectiveFrom')::timestamptz <= slot
  ), fields as (
    select distinct on (key) key, value
      from applicable cross join lateral jsonb_each(entry->'changes')
     order by key, boundary desc, ordinality desc
  )
  select base || coalesce((select jsonb_object_agg(key, value) from fields), '{}'::jsonb),
         coalesce((select max(ordinality)::integer from applicable), 0);
$$;
revoke all on function public.recurring_template_at(jsonb, jsonb, timestamptz) from public;
grant execute on function public.recurring_template_at(jsonb, jsonb, timestamptz) to savia_application;

-- Queue discovery is still metadata-only. Versions distinguish newly moved
-- occurrences from jobs already queued or completed for an older time.
grant select (workspace_id, rule_id, scheduled_at, effective_at, materialized, version)
  on public.recurring_occurrences to savia_elevated;
create policy elevated_reads_detached_recurring_occurrences on public.recurring_occurrences
  for select to savia_elevated using (not materialized and effective_at is not null);

grant create on schema public to savia_elevated;
create function public.find_due_detached_recurring_occurrences(cutoff timestamptz)
returns table ("workspaceId" uuid, subject uuid, "ruleId" uuid, "scheduledAt" text, "scheduleVersion" integer, "effectiveAt" timestamptz)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select r.workspace_id, r.created_by, r.id, occurrence.scheduled_at, o.version, o.effective_at
    from public.recurring_occurrences o
    join public.recurring_rules r on r.workspace_id = o.workspace_id and r.id = o.rule_id
    cross join lateral (select to_char(o.scheduled_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as scheduled_at) occurrence
   where not o.materialized and o.effective_at <= cutoff
     and exists (
       select 1 from public.workspace_memberships m
        where m.workspace_id = r.workspace_id and m.profile_id = r.created_by
          and m.status = 'active' and m.role in ('owner', 'administrator', 'editor')
     )
     and not exists (
       select 1 from public.jobs j
        where j.type = 'recurring_materialization' and j.workspace_id = r.workspace_id
          and j.payload->>'ruleId' = r.id::text
          and j.payload->>'scheduledAt' = occurrence.scheduled_at
          and coalesce(j.payload->>'scheduleVersion', '') = o.version::text
     )
   order by o.effective_at, r.id, o.scheduled_at
   limit 50;
$$;
alter function public.find_due_detached_recurring_occurrences(timestamptz) owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke all on function public.find_due_detached_recurring_occurrences(timestamptz) from public;
grant execute on function public.find_due_detached_recurring_occurrences(timestamptz) to savia_worker;

-- An exhausted rule can still have detached slots waiting to materialize.
drop policy elevated_reads_active_recurring_rules on public.recurring_rules;
create policy elevated_reads_due_recurring_rules on public.recurring_rules
  for select to savia_elevated using (active or exists (
    select 1 from public.recurring_occurrences o
     where o.workspace_id = recurring_rules.workspace_id and o.rule_id = recurring_rules.id
       and not o.materialized and o.effective_at is not null
  ));

drop index public.jobs_recurring_occurrence_key;
create unique index jobs_recurring_occurrence_key on public.jobs
  (workspace_id, (payload->>'ruleId'), (payload->>'scheduledAt'), (coalesce(payload->>'scheduleVersion', '')))
  where type = 'recurring_materialization';

commit;
