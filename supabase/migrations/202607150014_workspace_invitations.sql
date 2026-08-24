begin;

-- Workspace invitations schema.
-- Authority schema:
--   WorkspaceInvitation: { id, email, role, status, expiresAt, createdAt }
-- No version property or ETag story: no optimistic locking needed.

-- 1. Table
create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null
    check (char_length(email) between 3 and 320),
  -- NUL byte exclusion is enforced by the PostgreSQL type system (22021), not a check constraint.
  role text not null check (role in ('owner', 'administrator', 'editor', 'viewer')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  invited_by uuid not null references public.profiles(id) on delete restrict
);

-- RULING 15: expired is DERIVED, never stored.
-- The stored status column is constrained to ('pending', 'accepted', 'revoked') -- three values,
-- not four. The API's 'expired' is computed at read time as `status = 'pending' and expires_at <= now()`.
-- Storing it would require a sweeper job and would create a window in which a row reads pending
-- after its expiry. Deriving it is always correct and needs no scheduled work.
comment on column public.workspace_invitations.status is
  'Stored status: pending, accepted, revoked. Expired is derived at read time (status = pending and expires_at <= now()).';

-- on delete restrict on invited_by: a profile deletion must not silently erase the audit trail
-- of who invited whom. If that blocks a legitimate profile deletion, that is a decision for a
-- later slice to make explicitly, not something to paper over now.
comment on column public.workspace_invitations.invited_by is
  'Authoritative profile creator of the invitation; on delete restrict preserves audit trail.';

-- expires_at has NO default. The invitation lifetime is a policy decision belonging to slice 6.

-- RULING 16: one PENDING invitation per (workspace_id, lower(email)).
-- An index predicate must be IMMUTABLE, so now() cannot appear in it. The index therefore
-- covers pending rows regardless of expiry.
-- Consequence for slice 6: when createWorkspaceInvitation finds a pending row whose
-- expires_at <= now(), it must transition that row to revoked and insert a fresh one in the same
-- transaction. An expired invitation is functionally revoked, and making the transition explicit
-- is what keeps this index honest.
-- RULING 17: email compares case-insensitively, is stored as given.
create unique index workspace_invitations_one_pending_per_email
  on public.workspace_invitations (workspace_id, lower(email))
  where status = 'pending';

-- 2. RLS
alter table public.workspace_invitations enable row level security;
alter table public.workspace_invitations force row level security;

-- Grants: COLUMN-SCOPED where a write path must not re-point a row.
grant select on public.workspace_invitations to savia_application;
grant insert (workspace_id, email, role, expires_at, invited_by)
  on public.workspace_invitations to savia_application;
-- Column-scoped: only status. A table-wide update grant would let a write path re-point
-- workspace_id and seize an invitation (202607150011:11-14).
grant update (status)
  on public.workspace_invitations to savia_application;
-- No delete grant: Invitations are revoked, never deleted -- the status column is the record.

-- Policies. Uses public.workspace_actor_active_role(workspace_id) (202607150011) to avoid 42P17.
create policy application_reads_administered_invitation
  on public.workspace_invitations
  for select
  to savia_application
  using (
    public.workspace_actor_active_role(workspace_invitations.workspace_id)
      in ('owner', 'administrator')
  );

create policy application_inserts_administered_invitation
  on public.workspace_invitations
  for insert
  to savia_application
  with check (
    exists (
      select 1
      from public.workspaces workspace
      where workspace.id = workspace_invitations.workspace_id
        and workspace.kind in ('family', 'shared')
    )
    and public.workspace_actor_active_role(workspace_invitations.workspace_id)
          in ('owner', 'administrator')
    and (
      workspace_invitations.role <> 'owner'
      or public.workspace_actor_active_role(workspace_invitations.workspace_id) = 'owner'
    )
    -- Adapter-supplied attribution is forgeable; bind invited_by to authenticated subject (202607150007, 202607150011).
    and workspace_invitations.invited_by
          = nullif(current_setting('app.subject_id', true), '')::uuid
  );

-- Lifecycle is one-way: pending -> accepted or pending -> revoked.
-- PostgreSQL evaluates `using` against the OLD row and `with check` against the NEW row.
create policy application_updates_administered_invitation
  on public.workspace_invitations
  for update
  to savia_application
  using (
    public.workspace_actor_active_role(workspace_invitations.workspace_id)
      in ('owner', 'administrator')
    and workspace_invitations.status = 'pending'
  )
  with check (
    public.workspace_actor_active_role(workspace_invitations.workspace_id)
      in ('owner', 'administrator')
    and workspace_invitations.status in ('accepted', 'revoked')
  );

-- 3. Security-definer helper for slice 6: email already belongs to an active member (RULING 6).
-- savia_elevated already holds select (id, display_name, email) on public.profiles from 202607150013.
grant usage, create on schema public to savia_elevated;

create function public.workspace_email_has_active_member(
  target_workspace_id uuid,
  candidate_email text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when public.workspace_actor_active_role(target_workspace_id) in ('owner', 'administrator')
    then exists (
      select 1
      from public.workspace_memberships membership
      join public.profiles profile on profile.id = membership.profile_id
      where membership.workspace_id = target_workspace_id
        and membership.status = 'active'
        and lower(profile.email) = lower(candidate_email)
    )
    else false
  end;
$$;

alter function public.workspace_email_has_active_member(uuid, text) owner to savia_elevated;

-- Revoke create immediately after ownership transfer (RULING 13).
revoke create on schema public from savia_elevated;

revoke execute on function public.workspace_email_has_active_member(uuid, text) from public;
grant execute on function public.workspace_email_has_active_member(uuid, text) to savia_application;

commit;
