create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null check (char_length(display_name) between 1 and 120),
  locale text not null,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  timezone text not null,
  date_format text not null,
  week_starts_on smallint not null check (week_starts_on between 0 and 6),
  number_format text not null,
  default_currency char(3) not null check (default_currency ~ '^[A-Z]{3}$'),
  privacy_mode_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  kind text not null check (kind in ('personal', 'family', 'shared')),
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  personal_owner_profile_id uuid unique references public.profiles(id) on delete restrict,
  check ((kind = 'personal') = (personal_owner_profile_id is not null)),
  created_at timestamptz not null default now()
);

create table public.workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'administrator', 'editor', 'viewer')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  joined_at timestamptz not null default now(),
  unique (workspace_id, profile_id)
);

comment on column public.workspaces.personal_owner_profile_id is
  'Authoritative profile owner for personal workspaces; active owner membership must match.';

create function public.enforce_personal_workspace_owner_membership()
returns trigger
language plpgsql
as $$
declare
  target_workspace_id uuid;
  target_workspace_ids uuid[];
begin
  if tg_table_name = 'workspaces' then
    target_workspace_ids := array[coalesce(new.id, old.id)];
  elsif tg_op = 'INSERT' then
    target_workspace_ids := array[new.workspace_id];
  elsif tg_op = 'DELETE' then
    target_workspace_ids := array[old.workspace_id];
  else
    target_workspace_ids := array[old.workspace_id, new.workspace_id];
  end if;

  for target_workspace_id in
    select distinct unnest(target_workspace_ids)
  loop
    if exists (
      select 1
      from public.workspaces workspace
      where workspace.id = target_workspace_id
        and workspace.kind = 'personal'
        and (
          (select count(*) from public.workspace_memberships membership
           where membership.workspace_id = workspace.id
             and membership.role = 'owner'
             and membership.status = 'active') <> 1
          or not exists (
            select 1 from public.workspace_memberships membership
            where membership.workspace_id = workspace.id
              and membership.profile_id = workspace.personal_owner_profile_id
              and membership.role = 'owner'
              and membership.status = 'active'
          )
        )
    ) then
      raise exception 'personal workspace must have its designated active owner';
    end if;
  end loop;

  return null;
end;
$$;

create constraint trigger enforce_personal_workspace_owner_from_workspace
after insert or update on public.workspaces
deferrable initially deferred
for each row execute function public.enforce_personal_workspace_owner_membership();

create constraint trigger enforce_personal_workspace_owner_from_membership
after insert or update or delete on public.workspace_memberships
deferrable initially deferred
for each row execute function public.enforce_personal_workspace_owner_membership();
