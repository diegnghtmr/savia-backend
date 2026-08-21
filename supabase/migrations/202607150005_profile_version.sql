begin;
alter table public.profiles add column version integer;
update public.profiles set version = 1 where version is null;
set constraints all immediate;
alter table public.profiles alter column version set default 1;
alter table public.profiles alter column version set not null;
alter table public.profiles add constraint profiles_version_gte_1 check (version >= 1);

-- Column-scoped on purpose. A table-wide grant would let any future write path
-- change id, email or created_at, and the only thing standing between a client
-- and those columns would be application code remembering not to. These six are
-- exactly the fields UpdateUserProfileRequest can reach, plus the version the
-- server bumps itself.
grant update (display_name, locale, timezone, default_currency, privacy_mode_enabled, version)
  on public.profiles to savia_application;

create policy application_updates_own_profile
  on public.profiles
  for update
  to savia_application
  using (id = nullif(current_setting('app.subject_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.subject_id', true), '')::uuid);
commit;
