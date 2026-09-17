begin;

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null,
  file_name text not null,
  processing_location text not null,
  storage_path text not null,
  merchant jsonb,
  date jsonb,
  currency jsonb,
  total jsonb,
  transaction_id uuid,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version >= 1),
  constraint receipts_workspace_id_id_key unique (workspace_id, id),
  constraint receipts_status_check check (status in ('uploaded', 'processing', 'awaiting_review', 'confirmed', 'failed')),
  constraint receipts_processing_location_check check (processing_location in ('device', 'savia', 'external_provider')),
  constraint receipts_transaction_status_check check ((status = 'confirmed') = (transaction_id is not null)),
  constraint receipts_transaction_workspace_fkey foreign key (workspace_id, transaction_id)
    references public.transactions (workspace_id, id)
);

create index receipts_workspace_created_at_id_idx
  on public.receipts (workspace_id, created_at asc, id asc);
create index receipts_workspace_transaction_idx
  on public.receipts (workspace_id, transaction_id)
  where transaction_id is not null;

alter table public.receipts enable row level security;
alter table public.receipts force row level security;

grant select on public.receipts to savia_application;
grant insert (id, workspace_id, status, file_name, processing_location, storage_path,
              merchant, date, currency, total, created_by)
  on public.receipts to savia_application;
grant update (status, transaction_id, updated_at, version)
  on public.receipts to savia_application;

create policy application_reads_workspace_receipts on public.receipts
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_inserts_workspace_receipts on public.receipts
  for insert to savia_application
  with check (
    public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
    and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_workspace_receipts on public.receipts
  for update to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'))
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor'));

commit;
