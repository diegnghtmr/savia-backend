begin;

create table public.dashboard_preferences (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  cards jsonb not null check (jsonb_typeof(cards) = 'array'),
  period jsonb not null check (jsonb_typeof(period) = 'object'),
  presentation_currency char(3) not null check (presentation_currency ~ '^[A-Z]{3}$'),
  version integer not null check (version >= 2),
  primary key (profile_id, workspace_id)
);

alter table public.dashboard_preferences enable row level security;
alter table public.dashboard_preferences force row level security;
grant select, insert on public.dashboard_preferences to savia_application;
grant update (cards, period, presentation_currency, version) on public.dashboard_preferences to savia_application;

create policy application_owns_dashboard_preferences
  on public.dashboard_preferences for all to savia_application
  using (
    profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer')
  )
  with check (
    profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor', 'viewer')
  );

commit;
