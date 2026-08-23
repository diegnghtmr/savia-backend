begin;

select plan(18);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000011', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000012', 'other@example.test');

insert into public.profiles (
  id, email, display_name, locale, country_code, timezone, date_format,
  week_starts_on, number_format, default_currency
) values
  ('00000000-0000-0000-0000-000000000011', 'owner@example.test', 'Owner', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD'),
  ('00000000-0000-0000-0000-000000000012', 'other@example.test', 'Other', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD');

insert into public.workspaces (id, name, kind, base_currency) values
  ('00000000-0000-0000-0000-000000000021', 'Owner workspace', 'shared', 'USD'),
  ('00000000-0000-0000-0000-000000000022', 'Other workspace', 'shared', 'USD');

insert into public.workspace_memberships (workspace_id, profile_id, role) values
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011', 'owner'),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000012', 'owner');

select is(
  (select count(*)::integer from public.profiles),
  2,
  'setup persists both protected profiles'
);
select is(
  (select rolbypassrls from pg_roles where rolname = 'savia_application'),
  false,
  'application role cannot bypass RLS'
);
select isnt(
  (select relowner from pg_class where oid = 'public.profiles'::regclass),
  (select oid from pg_roles where rolname = 'savia_application'),
  'application role does not own protected tables'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.profiles'::regclass),
  true,
  'profiles force row-level security'
);

grant usage on schema extensions to savia_application, savia_elevated;
grant execute on all functions in schema extensions to savia_application, savia_elevated;
grant execute on all functions in schema public to savia_application, savia_elevated;

set local role savia_application;
set local search_path = extensions, public;
select set_config('app.subject_id', '00000000-0000-0000-0000-000000000011', true);
select is(
  (select count(*)::integer from public.profiles),
  1,
  'application subject reads its own profile'
);
select is(
  (select count(*)::integer from public.profiles where id = '00000000-0000-0000-0000-000000000012'),
  0,
  'cross-user profile query discloses no row'
);
select is(
  (select count(*)::integer from public.workspaces),
  1,
  'application subject reads its own workspace'
);
select is(
  (select count(*)::integer from public.workspace_memberships),
  1,
  'application subject reads only its workspace membership'
);

commit;

select is(
  current_setting('app.subject_id', true),
  '',
  'transaction-local subject clears after commit'
);

begin;
set local role savia_application;
set local search_path = extensions, public;
select set_config('app.subject_id', '00000000-0000-0000-0000-000000000012', true);
select is(
  (select count(*)::integer from public.profiles),
  1,
  'pooled connection accepts a new transaction-local subject'
);
rollback;

select is(
  current_setting('app.subject_id', true),
  '',
  'transaction-local subject clears after rollback'
);

begin;
set local role savia_application;
set local search_path = extensions, public;
select is(
  (select count(*)::integer from public.profiles),
  0,
  'pooled reuse without a subject discloses no profile'
);
rollback;

begin;
set local role savia_elevated;
set local search_path = extensions, public;
-- 202607150013 grants savia_elevated a COLUMN-SCOPED select on public.profiles, because the
-- security-definer projection workspace_member_roster executes as savia_elevated and must read
-- a peer's display_name and email -- application_reads_own_profile is self-only, so a plain join
-- returns NULL for every peer and WorkspaceMember.displayName is required by the authority.
-- These three assertions pin exactly how far that grant reaches. The positive control comes
-- first: without it the two 42501 assertions could not distinguish "the column is protected"
-- from "the role cannot read profiles at all", and the grant could be deleted without failing
-- a test.
select lives_ok(
  $$select id, display_name, email from public.profiles$$,
  'elevated role reads the three columns the member roster projects'
);
select throws_ok(
  $$select privacy_mode_enabled from public.profiles$$,
  '42501',
  NULL,
  'elevated role cannot read privacy_mode_enabled'
);
select throws_ok(
  $$select default_currency, locale from public.profiles$$,
  '42501',
  NULL,
  'elevated role cannot read default_currency or locale'
);
select throws_ok(
  $$update public.profiles set display_name = 'seized'$$,
  '42501',
  NULL,
  'elevated role has no write grant on profiles'
);
rollback;

select is(
  (select relforcerowsecurity from pg_class where oid = 'public.workspaces'::regclass),
  true,
  'workspaces force row-level security'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.workspace_memberships'::regclass),
  true,
  'memberships force row-level security'
);

select * from finish();
