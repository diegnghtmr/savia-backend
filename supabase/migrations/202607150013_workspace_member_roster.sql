begin;
grant usage, create on schema public to savia_elevated;   -- revoked below (RULING 13)
-- COLUMN-SCOPED, per the doctrine at 202607150011:11-14. The projection below reads exactly
-- three profile columns, so savia_elevated is granted exactly those three. A table-wide
-- `grant select on public.profiles` would put privacy_mode_enabled, default_currency and locale
-- inside the elevated role's reach, leaving the projection's RETURN TYPE as the only thing
-- keeping them out of a response. With this grant they are unreachable at the PRIVILEGE layer
-- as well, and identity_rls.test.sql pins that with a 42501.
grant select (id, display_name, email) on public.profiles to savia_elevated;

-- savia_elevated is nobypassrls (202607150002:9-15) and public.profiles carries
-- `force row level security` (202607150002:23-24), so the grant alone yields zero rows.
-- This policy is what makes the projection able to read a peer's profile row at all.
create policy elevated_reads_profiles
  on public.profiles for select to savia_elevated using (true);

-- ONE projection serves the roster (RULING 10, extended by RULING 14 with membership_id).
-- Column restriction is enforced by the RETURN TYPE, so it cannot be widened by accident:
-- privacy_mode_enabled, default_currency and locale are not expressible here.
--
-- STABLE, not VOLATILE. This function takes no lock: it has no `select ... for update`, so it
-- needs no volatility. Slice 1b's collaborative_workspace_retains_active_owner
-- (202607150012:27-55) is VOLATILE precisely because it does lock -- a STABLE body there raises
-- `SELECT FOR UPDATE is not allowed in a non-volatile function`. The two differ on purpose.
-- Do not "fix" the inconsistency in either direction.
--
-- No subject parameter. The caller's identity is read INSIDE the body, through
-- public.workspace_actor_active_role (202607150011:26-36), which itself reads
-- current_setting('app.subject_id', true). The adapter calls this function directly, with no
-- policy WITH CHECK to bind an argument, so a subject parameter would be forgeable.
--
-- `email` is projected only when the caller's OWN active role is owner or administrator
-- (RULING 11); NULL otherwise. WorkspaceMember.email is optional in the authority
-- (docs/savia-openapi.yaml:3576-3604), so withholding it is contract-valid.
--
-- Every column reference below is table-qualified. The RETURNS TABLE column names are OUT
-- parameters and an unqualified reference to one of them would be ambiguous (42702). If you hit
-- 42702, qualify the reference -- never rename a return column.
create function public.workspace_member_roster(target_workspace_id uuid)
returns table (
  membership_id uuid, profile_id uuid, display_name text, email text,
  role text, status text, joined_at timestamptz, version integer
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select membership.id, membership.profile_id, profile.display_name,
         case when public.workspace_actor_active_role(target_workspace_id)
                   in ('owner','administrator')
              then profile.email end,
         membership.role, membership.status, membership.joined_at, membership.version
  from public.workspace_memberships membership
  join public.profiles profile on profile.id = membership.profile_id
  where membership.workspace_id = target_workspace_id
    and public.workspace_actor_active_role(target_workspace_id) is not null;
$$;
alter function public.workspace_member_roster(uuid) owner to savia_elevated;

-- Immediately after the ownership transfer, never later. A permanently granted `create` on
-- schema public was the C4 defect (RULING 13; same sequence as 202607150007:12,53 and
-- 202607150011:16,38).
revoke create on schema public from savia_elevated;

revoke execute on function public.workspace_member_roster(uuid) from public;
grant execute on function public.workspace_member_roster(uuid) to savia_application;
commit;
