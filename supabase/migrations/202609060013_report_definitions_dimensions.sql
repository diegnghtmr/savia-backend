begin;

-- Refuse deployment while legacy report definitions still contain a dimension
-- removed from the application contract. The count and remediation make the
-- migration failure actionable for operators.
do $$
declare
  unsupported_count bigint;
begin
  select count(*)
    into unsupported_count
    from public.report_definitions
   where not (dimensions <@ '["date", "day", "week", "month", "quarter", "year", "account", "account_type", "category", "tag", "payee", "currency", "member", "status", "transaction_type"]'::jsonb);

  if unsupported_count > 0 then
    raise exception '% report definition(s) contain unsupported dimensions; remove unsupported dimensions and retry the migration', unsupported_count;
  end if;
end;
$$;

alter table public.report_definitions
  add constraint report_definitions_dimensions_allowed_check
  check (dimensions <@ '["date", "day", "week", "month", "quarter", "year", "account", "account_type", "category", "tag", "payee", "currency", "member", "status", "transaction_type"]'::jsonb);

commit;
