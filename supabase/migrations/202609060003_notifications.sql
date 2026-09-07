begin;

-- Slice: Subject-scoped notifications (listNotifications, markNotificationRead).
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  action_url text,
  read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  -- The notification type vocabulary is deliberately not frozen because no producer exists yet,
  -- and the first producer slice owns that decision. We constrain the structural format:
  -- non-empty, bounded length (1 to 64 chars, justified against title's 1-255 bound),
  -- and lowercase snake_case format matching ^[a-z][a-z0-9_]*$.
  constraint notifications_type_check check (
    char_length(type) between 1 and 64
    and type ~ '^[a-z][a-z0-9_]*$'
  ),
  constraint notifications_title_length_check check (
    char_length(title) between 1 and 255
  ),
  constraint notifications_read_state_check check (
    (read = true and read_at is not null)
    or
    (read = false and read_at is null)
  )
);

create index notifications_subject_created_at_id_idx
  on public.notifications (subject_id, created_at asc, id asc);

create index notifications_subject_unread_created_at_id_idx
  on public.notifications (subject_id, created_at asc, id asc)
  where read = false;

alter table public.notifications enable row level security;
alter table public.notifications force row level security;

grant select on public.notifications to savia_application;
grant update (read, read_at) on public.notifications to savia_application;

-- Scoped directly to the bearer subject.
-- There is no workspace membership helper to route through here:
-- this is the one table in the system where public.workspace_actor_active_role does not apply.
create policy application_reads_own_notifications on public.notifications
  for select to savia_application
  using (
    subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_updates_own_notifications on public.notifications
  for update to savia_application
  using (
    subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
  )
  with check (
    subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
  );

commit;
