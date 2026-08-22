begin;

create table public.command_idempotency_records (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.profiles(id) on delete cascade,
  route text not null check (char_length(route) between 1 and 120),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 255),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_status smallint not null check (response_status between 100 and 599),
  response_etag text,
  response_body jsonb,
  created_at timestamptz not null default now(),
  unique (subject_id, route, idempotency_key)
);

create index command_idempotency_records_created_at_idx
  on public.command_idempotency_records (created_at);

alter table public.command_idempotency_records enable row level security;
alter table public.command_idempotency_records force row level security;

grant select, insert on public.command_idempotency_records to savia_application;

-- Column-scoped, never table-wide. id, subject_id, route and idempotency_key are the
-- record's identity and the `on conflict` target; a table-wide grant would let a write
-- path re-point an existing record at another subject.
grant update (request_fingerprint, response_status, response_etag, response_body, created_at)
  on public.command_idempotency_records to savia_application;

create policy application_reads_own_idempotency_record
  on public.command_idempotency_records
  for select
  to savia_application
  using (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);

create policy application_inserts_own_idempotency_record
  on public.command_idempotency_records
  for insert
  to savia_application
  with check (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);

-- The one policy in this change where `with check` earns its keep: `using` reads
-- created_at and the statement SETS created_at = now(), so reusing `using` as the check
-- would reject every successful expiry reclaim. General rule for this codebase: declare
-- `with check` ONLY when `using` reads a column the statement mutates -- otherwise
-- PostgreSQL applies `using` as the check and a duplicate adds nothing.
create policy application_expires_own_idempotency_record
  on public.command_idempotency_records
  for update
  to savia_application
  using (
    subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and created_at <= now() - interval '24 hours'
  )
  with check (subject_id = nullif(current_setting('app.subject_id', true), '')::uuid);

commit;
