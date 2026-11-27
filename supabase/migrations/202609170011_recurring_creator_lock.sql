begin;

-- Like claim_approval, use the existing elevated membership row-lock policy.
-- FOR SHARE conflicts with both membership deletion and non-key role/status updates.
create function public.lock_recurring_creator_membership(target_workspace_id uuid)
returns boolean language sql volatile security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.workspace_memberships m
     where m.workspace_id = target_workspace_id
       and m.profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
       and m.status = 'active' and m.role in ('owner', 'administrator', 'editor')
     for share
  );
$$;

grant create on schema public to savia_elevated;
alter function public.lock_recurring_creator_membership(uuid) owner to savia_elevated;
revoke create on schema public from savia_elevated;
revoke all on function public.lock_recurring_creator_membership(uuid)
  from public, anon, authenticated, service_role, savia_worker;
grant execute on function public.lock_recurring_creator_membership(uuid) to savia_application;

commit;
