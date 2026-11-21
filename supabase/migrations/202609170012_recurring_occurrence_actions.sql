begin;

-- The prospective slot is addressable before the job records it. Previously
-- recorded occurrences keep their IDs. UTC microseconds preserve the key.
create function public.recurring_occurrence_slot_id(target_rule uuid, slot timestamptz)
returns uuid language sql stable strict set search_path = pg_catalog
as $$
  select md5(target_rule::text || '/' || to_char(slot at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::uuid;
$$;
revoke all on function public.recurring_occurrence_slot_id(uuid, timestamptz) from public;
grant execute on function public.recurring_occurrence_slot_id(uuid, timestamptz) to savia_application;

alter table public.recurring_occurrences
  add column template jsonb,
  add column skipped_at timestamptz,
  add column version integer not null default 2 check (version >= 2);

update public.recurring_occurrences o
   set template = r.template
  from public.recurring_rules r
 where r.workspace_id = o.workspace_id and r.id = o.rule_id;

alter table public.recurring_occurrences
  alter column template set not null,
  drop constraint recurring_occurrences_check,
  add constraint recurring_occurrences_booking_check
    check (skipped_at is not null or behavior = 'remind' or transaction_id is not null);

grant select on public.recurring_occurrences to savia_application;
grant insert (template, skipped_at) on public.recurring_occurrences to savia_application;
grant update (transaction_id, skipped_at, version) on public.recurring_occurrences to savia_application;

create policy application_reads_workspace_occurrences
  on public.recurring_occurrences for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_updates_creator_occurrences
  on public.recurring_occurrences for update to savia_application
  using (
    public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    and exists (
      select 1 from public.recurring_rules r
      where r.workspace_id = recurring_occurrences.workspace_id
        and r.id = recurring_occurrences.rule_id
        and r.created_by = nullif(current_setting('app.subject_id', true), '')::uuid
    )
  );

commit;
