begin;

alter table public.notifications
  add column workspace_id uuid references public.workspaces(id) on delete cascade,
  add column resource_id uuid,
  add constraint notifications_workspace_resource_check
    check ((workspace_id is null) = (resource_id is null)),
  add constraint notifications_event_key
    unique (workspace_id, subject_id, type, resource_id);

-- Legacy notifications remain recipient-scoped. Produced rows also require
-- current workspace access, including when marking them as read.
create policy application_requires_notification_workspace_access on public.notifications
  as restrictive for all to savia_application
  using (workspace_id is null or public.workspace_actor_active_role(workspace_id) is not null);

-- These producers run as the originating actor, including in worker transactions.
grant insert (workspace_id, subject_id, type, resource_id, title)
  on public.notifications to savia_application;

create policy application_inserts_own_workspace_notifications on public.notifications
  for insert to savia_application
  with check (
    subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
  );

commit;
