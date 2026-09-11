begin;

do $$
declare
  orphan_count integer;
begin
  select count(*)::integer into orphan_count
    from public.ai_credentials
   where owner_type = 'user'
     and created_by_subject_id is null;

  if orphan_count > 0 then
    raise exception 'ai credential owner constraint refused: % user-owned orphan row(s); remediation: assign the original creator subject before retrying; private secrets are never converted to workspace ownership', orphan_count;
  end if;
end;
$$;

alter table public.ai_credentials
  add constraint ai_credentials_owner_required
  check (owner_type <> 'user' or created_by_subject_id is not null);

commit;
