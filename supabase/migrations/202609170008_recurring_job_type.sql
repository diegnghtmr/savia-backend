begin;

alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check check (type in (
  'import_commit', 'import_rollback', 'balance_forecast', 'report_run',
  'export_job', 'receipt_ocr', 'recurring_materialization'
));

-- Terminal jobs are also excluded from rediscovery. Redelivery belongs to JobRunner,
-- not to the poller, so a poison occurrence cannot generate jobs forever.
create unique index jobs_recurring_occurrence_key on public.jobs
  (workspace_id, (payload->>'ruleId'), (payload->>'scheduledAt'))
  where type = 'recurring_materialization';

create index recurring_rules_active_due_idx on public.recurring_rules
  (next_occurrence_at, id) where active;

-- Discovery reads only scheduler metadata. All writes still run under the creator.
grant select (id, workspace_id, created_by, active, next_occurrence_at, ends_at)
  on public.recurring_rules to savia_elevated;
grant select (type, payload) on public.jobs to savia_elevated;
create policy elevated_reads_active_recurring_rules on public.recurring_rules
  for select to savia_elevated using (active);

grant create on schema public to savia_elevated;
create function public.find_due_recurring_occurrences(cutoff timestamptz)
returns table ("workspaceId" uuid, subject uuid, "ruleId" uuid, "scheduledAt" text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select r.workspace_id, r.created_by, r.id, occurrence.scheduled_at
    from public.recurring_rules r
    cross join lateral (select to_char(r.next_occurrence_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as scheduled_at) occurrence
   where r.active and r.next_occurrence_at <= cutoff
     and (r.ends_at is null or r.next_occurrence_at <= r.ends_at)
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
     )
   order by r.next_occurrence_at, r.id
   limit 50;
$$;
alter function public.find_due_recurring_occurrences(timestamptz) owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke all on function public.find_due_recurring_occurrences(timestamptz) from public;
grant execute on function public.find_due_recurring_occurrences(timestamptz) to savia_worker;

commit;
