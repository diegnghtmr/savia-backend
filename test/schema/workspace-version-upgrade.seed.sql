do $$
begin
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000401', 'upgrade@example.test'),
  ('00000000-0000-0000-0000-000000000402', 'other@example.test');
insert into public.profiles (
  id, email, display_name, locale, country_code, timezone, date_format,
  week_starts_on, number_format, default_currency
) values
  ('00000000-0000-0000-0000-000000000401', 'upgrade@example.test', 'Upgrade', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD'),
  ('00000000-0000-0000-0000-000000000402', 'other@example.test', 'Other', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,000.00', 'USD');
insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
values ('00000000-0000-0000-0000-000000000403', 'Upgrade personal', 'personal', 'USD', '00000000-0000-0000-0000-000000000401');
insert into public.workspace_memberships (workspace_id, profile_id, role)
values ('00000000-0000-0000-0000-000000000403', '00000000-0000-0000-0000-000000000401', 'owner');
set constraints all immediate;
end;
$$;
