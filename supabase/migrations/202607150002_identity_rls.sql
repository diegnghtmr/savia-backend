create role savia_application
  nologin
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  nobypassrls;

create role savia_elevated
  nologin
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  nobypassrls;

grant savia_application, savia_elevated to postgres;

grant usage on schema public to savia_application;
grant select on public.profiles, public.workspaces, public.workspace_memberships
  to savia_application;

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_memberships force row level security;

create policy application_reads_own_profile
  on public.profiles
  for select
  to savia_application
  using (
    id = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_reads_own_membership
  on public.workspace_memberships
  for select
  to savia_application
  using (
    profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
  );

create policy application_reads_member_workspace
  on public.workspaces
  for select
  to savia_application
  using (
    exists (
      select 1
      from public.workspace_memberships membership
      where membership.workspace_id = workspaces.id
        and membership.profile_id = nullif(
          current_setting('app.subject_id', true), ''
        )::uuid
    )
  );
