begin;

select plan(23);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000101', 'bootstrap@example.test'),
  ('00000000-0000-0000-0000-000000000102', 'other@example.test'),
  ('00000000-0000-0000-0000-000000000103', 'partial@example.test');

insert into public.workspaces (id, name, kind, base_currency) values
  ('00000000-0000-0000-0000-000000000201', 'Guessed shared', 'shared', 'USD');

select is(
  (select count(*)::integer from pg_policies
   where schemaname = 'public' and tablename = 'profiles'
     and policyname = 'application_inserts_own_profile'),
  1,
  'profile INSERT policy is installed'
);
select is(
  (select count(*)::integer from pg_policies
   where schemaname = 'public' and tablename = 'workspace_memberships'
     and policyname = 'application_inserts_personal_owner_membership'),
  1,
  'membership INSERT policy is installed'
);
select ok(
  (select coalesce(with_check, '') like '%app.subject_id%' from pg_policies
   where schemaname = 'public' and tablename = 'workspace_memberships'
     and policyname = 'application_inserts_personal_owner_membership'),
  'membership policy remains subject-bound'
);
select is(
  has_table_privilege('savia_application', 'public.profiles', 'INSERT'),
  true,
  'application receives profile INSERT only'
);
select is(
  has_table_privilege('savia_application', 'public.profiles', 'UPDATE'),
  false,
  'application receives no profile UPDATE grant'
);
select is(
  has_table_privilege('savia_application', 'public.workspace_memberships', 'DELETE'),
  false,
  'application receives no membership DELETE grant'
);
select is(
  (select bool_and(relforcerowsecurity)
   from pg_class
   where oid in (
     'public.profiles'::regclass,
     'public.workspaces'::regclass,
     'public.workspace_memberships'::regclass
   )),
  true,
  'all bootstrap tables remain FORCE RLS'
);
select is(
  (select tgdeferrable and tginitdeferred
   from pg_trigger
   where tgname = 'enforce_profile_personal_workspace_totality'),
  true,
  'profile totality trigger remains deferred'
);
select is(
  (select prosecdef from pg_proc
   where oid = 'public.enforce_profile_personal_workspace_totality()'::regprocedure),
  false,
  'profile totality function remains SECURITY INVOKER'
);
select ok(
  (select tgrelid = 'public.profiles'::regclass
    and tgfoid = 'public.enforce_profile_personal_workspace_totality()'::regprocedure
    and tgtype = 21 and tgdeferrable and tginitdeferred
    and pg_get_expr(tgqual, 0) = '(CURRENT_USER = ''savia_application''::name)'
   from pg_trigger where tgname = 'enforce_profile_personal_workspace_totality'),
  'profile totality trigger keeps its profile/function/events/deferred/application WHEN binding'
);

grant usage on schema extensions to savia_application;
grant execute on all functions in schema extensions to savia_application;
grant execute on all functions in schema public to savia_application;

set local role savia_application;
set local search_path = extensions, public;
select set_config('app.subject_id', '00000000-0000-0000-0000-000000000101', true);

insert into public.profiles (
  id, email, display_name, locale, country_code, timezone, date_format,
  week_starts_on, number_format, default_currency
) values (
  '00000000-0000-0000-0000-000000000101', 'bootstrap@example.test', 'Bootstrap',
  'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD'
);
insert into public.workspaces (
  id, name, kind, base_currency, personal_owner_profile_id
) values (
  '00000000-0000-0000-0000-000000000202', 'Bootstrap personal', 'personal', 'USD',
  '00000000-0000-0000-0000-000000000101'
);
insert into public.workspace_memberships (
  id, workspace_id, profile_id, role, status
) values (
  '00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000202',
  '00000000-0000-0000-0000-000000000101', 'owner', 'active'
);
set constraints all immediate;

select is(
  (select count(*)::bigint from public.workspaces
   where personal_owner_profile_id = '00000000-0000-0000-0000-000000000101'),
  1::bigint,
  'application can atomically create its personal workspace'
);
select is(
  (select count(*)::bigint from public.workspace_memberships
   where workspace_id = '00000000-0000-0000-0000-000000000202'
     and role = 'owner' and status = 'active'),
  1::bigint,
  'application can atomically create its active Owner membership'
);
select set_config('app.subject_id', '00000000-0000-0000-0000-000000000103', true);
select throws_ok(
  $$insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency)
    values ('00000000-0000-0000-0000-000000000103', 'partial@example.test', 'Partial', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD');
    set constraints all immediate;$$,
  'P0001',
  'profile must own exactly one personal workspace with one active Owner membership',
  'profile-only application write fails totality without a partial commit'
);
select throws_ok(
  $$insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
    values ('00000000-0000-0000-0000-000000000204', 'Other personal', 'personal', 'USD', '00000000-0000-0000-0000-000000000102');$$,
  '42501',
  'new row violates row-level security policy for table "workspaces"',
  'cross-user personal workspace creation is denied'
);
select set_config('app.subject_id', '00000000-0000-0000-0000-000000000101', true);
select throws_ok(
  $$insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
    values ('00000000-0000-0000-0000-000000000205', 'Partial personal', 'personal', 'USD', '00000000-0000-0000-0000-000000000103');$$,
  '42501',
  'new row violates row-level security policy for table "workspaces"',
  'workspace-only application write cannot target another or missing profile'
);
select throws_ok(
  $$insert into public.workspace_memberships (workspace_id, profile_id, role, status)
    values ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 'owner', 'active');$$,
  '42501',
  'new row violates row-level security policy for table "workspace_memberships"',
  'guessed collaborative workspace self-enrollment is denied'
);
select throws_ok(
  $$insert into public.workspace_memberships (workspace_id, profile_id, role, status)
    values ('00000000-0000-0000-0000-000000000299', '00000000-0000-0000-0000-000000000101', 'owner', 'active');$$,
  '42501',
  'new row violates row-level security policy for table "workspace_memberships"',
  'missing workspace membership target is denied without disclosure'
);
select throws_ok(
  $$insert into public.workspace_memberships (workspace_id, profile_id, role, status)
    values ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000101', 'editor', 'active');$$,
  '42501',
  'new row violates row-level security policy for table "workspace_memberships"',
  'non-owner membership is denied'
);
select throws_ok(
  $$insert into public.workspace_memberships (workspace_id, profile_id, role, status)
    values ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000101', 'owner', 'suspended');$$,
  '42501',
  'new row violates row-level security policy for table "workspace_memberships"',
  'inactive membership is denied'
);
select is(
  (select count(*)::bigint from public.workspaces
   where id = '00000000-0000-0000-0000-000000000201'),
  0::bigint,
  'guessed shared workspace remains invisible to the application subject'
);
select throws_ok(
  $$insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency)
    values ('00000000-0000-0000-0000-000000000102', 'other@example.test', 'Other', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD');$$,
  '42501',
  'new row violates row-level security policy for table "profiles"',
  'client-supplied cross-subject profile ID is denied'
);

reset role;
commit;

select is(
  current_setting('app.subject_id', true),
  '',
  'transaction-local bootstrap subject clears after commit'
);

begin;
set local role savia_application;
set local search_path = extensions, public;
select set_config('app.subject_id', '00000000-0000-0000-0000-000000000101', true);
rollback;

select is(
  current_setting('app.subject_id', true),
  '',
  'transaction-local bootstrap subject clears after rollback'
);
select * from finish();
