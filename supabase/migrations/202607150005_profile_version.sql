begin;
alter table public.profiles add column version integer;
update public.profiles set version = 1 where version is null;
set constraints all immediate;
alter table public.profiles alter column version set default 1;
alter table public.profiles alter column version set not null;
alter table public.profiles add constraint profiles_version_gte_1 check (version >= 1);

grant update on public.profiles to savia_application;

create policy application_updates_own_profile
  on public.profiles
  for update
  to savia_application
  using (id = nullif(current_setting('app.subject_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.subject_id', true), '')::uuid);
commit;
