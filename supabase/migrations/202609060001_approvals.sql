begin;

-- Epica 9 slice 1: approvals get, confirm, and reject.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  tool_name text not null,
  risk_class text not null,
  arguments_hash text not null,
  preview jsonb not null default '{}'::jsonb,
  status text not null,
  expires_at timestamptz not null,
  decided_by uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  decision_reason text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint approvals_workspace_id_id_key unique (workspace_id, id),
  constraint approvals_risk_class_check check (risk_class in ('low_risk_write', 'financial_write', 'destructive', 'administrative')),
  constraint approvals_status_check check (status in ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  constraint approvals_preview_is_object_check check (jsonb_typeof(preview) = 'object'),
  constraint approvals_decided_state_check check (
    (status in ('approved', 'rejected') and decided_at is not null and decided_by is not null)
    or
    (status not in ('approved', 'rejected') and decided_at is null and decided_by is null)
  )
);

create index approvals_workspace_created_at_id_idx
  on public.approvals (workspace_id, created_at asc, id asc);

alter table public.approvals enable row level security;
alter table public.approvals force row level security;

grant select on public.approvals to savia_application;
grant update (status, decided_by, decided_at, decision_reason) on public.approvals to savia_application;

create policy application_reads_workspace_approvals on public.approvals
  for select to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer'));

create policy application_updates_workspace_approvals on public.approvals
  for update to savia_application
  using (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator'))
  with check (public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator'));

commit;
