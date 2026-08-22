begin;
grant usage, create on schema public to savia_elevated;   -- revoked below (RULING 13)

-- `using (true)` is required so `select ... for update` can see and lock rows.
-- `with check (false)` is independently load-bearing: savia_elevated already has SELECT
-- visibility via elevated_reads_memberships and UPDATE(role, status, version), so
-- `with check (true)` would permit direct writes to those columns.
-- Dropping this UPDATE policy silently yields zero locked rows, which makes any guard
-- built on it fail OPEN. Revoking the UPDATE grant instead fails closed with 42501.
grant update (role, status, version) on public.workspace_memberships to savia_elevated;

-- `using` is what the row-locking clause consults; `with check (false)` keeps a lock
-- capability from becoming a write capability. Executed: the locking count returns 1, and a
-- real UPDATE returns 42501 `new row violates row-level security policy` with the row
-- verifiably unchanged (#4227 FINDING 5). This is the case 202607150010:42-46 describes --
-- declare `with check` only when it must differ from `using`.
create policy elevated_locks_memberships
  on public.workspace_memberships for update to savia_elevated
  using (true) with check (false);

-- VOLATILE, and it MUST stay volatile. Executed: a STABLE body raises
-- `ERROR: SELECT FOR UPDATE is not allowed in a non-volatile function` (#4227 FINDING 4).
-- Both existing helpers (202607150007:31, 202607150009:18) are STABLE; this one differs on
-- purpose. Do not "fix" the inconsistency.
-- No subject parameter: this is called directly by the adapter, with no policy WITH CHECK to
-- bind a parameter, so a subject argument would be forgeable (#4227 FINDING 6).
create function public.collaborative_workspace_retains_active_owner(
  target_workspace_id uuid,
  excluded_membership_id uuid
) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare remaining integer;
begin
  -- Fail-closed allow-list (202607150009:105-106).
  if not exists (select 1 from public.workspaces workspace
                 where workspace.id = target_workspace_id
                   and workspace.kind in ('family','shared')) then
    return false;
  end if;

  select count(*) into remaining
  from (select membership.id
        from public.workspace_memberships membership
        where membership.workspace_id = target_workspace_id
          and membership.role = 'owner'
          and membership.status = 'active'
        order by membership.id            -- deterministic lock order: a mitigation, not a guarantee
        for update) locked
  where locked.id is distinct from excluded_membership_id;

  return remaining >= 1;
end;
$$;
alter function public.collaborative_workspace_retains_active_owner(uuid, uuid)
  owner to savia_elevated;

-- DB-layer backstop. UPDATE/DELETE only: an INSERT can never remove the last owner.
-- security definer, so it is not blind the way 202607150001:39 is.
-- VOLATILE, and it MUST stay volatile for SELECT ... FOR UPDATE.
create function public.enforce_collaborative_workspace_owner_membership()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  target_workspace_id uuid;
  remaining integer;
begin
  foreach target_workspace_id in array
    (case when tg_op = 'DELETE' then array[old.workspace_id]
          else array[old.workspace_id, new.workspace_id] end)
  loop
    if exists (select 1 from public.workspaces workspace
               where workspace.id = target_workspace_id
                 and workspace.kind in ('family','shared')) then
      select count(*) into remaining
      from (select membership.id
            from public.workspace_memberships membership
            where membership.workspace_id = target_workspace_id
              and membership.role = 'owner'
              and membership.status = 'active'
            order by membership.id            -- deterministic lock order: a mitigation, not a guarantee
            for update) locked;

      if remaining < 1 then
        raise exception 'collaborative workspace must retain an active owner'
          using errcode = 'check_violation';
      end if;
    end if;
  end loop;
  return null;
end;
$$;
alter function public.enforce_collaborative_workspace_owner_membership() owner to savia_elevated;

revoke create on schema public from savia_elevated;
revoke execute on function public.collaborative_workspace_retains_active_owner(uuid, uuid) from public;
revoke execute on function public.enforce_collaborative_workspace_owner_membership() from public;
grant execute on function public.collaborative_workspace_retains_active_owner(uuid, uuid)
  to savia_application;

create constraint trigger enforce_collaborative_owner_from_membership
after update or delete on public.workspace_memberships
deferrable initially deferred
for each row execute function public.enforce_collaborative_workspace_owner_membership();
commit;
