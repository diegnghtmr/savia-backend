grant insert on public.profiles, public.workspaces, public.workspace_memberships to savia_application;

create policy application_inserts_own_profile
  on public.profiles
  for insert
  to savia_application
  with check (id = nullif(current_setting('app.subject_id', true), '')::uuid);

create policy application_inserts_own_personal_workspace
  on public.workspaces
  for insert
  to savia_application
  with check (kind = 'personal' and personal_owner_profile_id = nullif(current_setting('app.subject_id', true), '')::uuid);

create policy application_inserts_personal_owner_membership
  on public.workspace_memberships
  for insert
  to savia_application
  with check (profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
    and role = 'owner' and status = 'active' and exists (select 1 from public.workspaces workspace
      where workspace.id = workspace_id and workspace.kind = 'personal'
        and workspace.personal_owner_profile_id = nullif(current_setting('app.subject_id', true), '')::uuid));

alter policy application_reads_member_workspace on public.workspaces
  using (personal_owner_profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
    or exists (select 1 from public.workspace_memberships membership
      where membership.workspace_id = workspaces.id
        and membership.profile_id = nullif(current_setting('app.subject_id', true), '')::uuid));

create function public.enforce_profile_personal_workspace_totality()
returns trigger
language plpgsql
as $$
declare
  subject_id uuid := nullif(current_setting('app.subject_id', true), '')::uuid;
begin
  if subject_id is null or new.id <> subject_id then
    raise exception 'profile bootstrap must use the transaction subject';
  end if;

  if (
    select count(*)
    from public.workspaces workspace
    where workspace.kind = 'personal'
      and workspace.personal_owner_profile_id = new.id
  ) <> 1
  or (
    select count(*)
    from public.workspace_memberships membership
    join public.workspaces workspace on workspace.id = membership.workspace_id
    where workspace.kind = 'personal'
      and workspace.personal_owner_profile_id = new.id
      and membership.profile_id = new.id
      and membership.role = 'owner'
      and membership.status = 'active'
  ) <> 1 then
    raise exception
      'profile must own exactly one personal workspace with one active Owner membership';
  end if;

  return null;
end;
$$;

do $$
begin
  if exists (
    select 1
    from public.profiles profile
    where (
      select count(*)
      from public.workspaces workspace
      where workspace.kind = 'personal'
        and workspace.personal_owner_profile_id = profile.id
    ) <> 1
    or (
      select count(*)
      from public.workspace_memberships membership
      join public.workspaces workspace on workspace.id = membership.workspace_id
      where workspace.kind = 'personal'
        and workspace.personal_owner_profile_id = profile.id
        and membership.profile_id = profile.id
        and membership.role = 'owner'
        and membership.status = 'active'
    ) <> 1
  ) then
    raise exception 'existing profile bootstrap aggregate is incomplete';
  end if;
end;
$$;

create constraint trigger enforce_profile_personal_workspace_totality
after insert or update of id on public.profiles
deferrable initially deferred
for each row
when (current_user = 'savia_application')
execute function public.enforce_profile_personal_workspace_totality();
