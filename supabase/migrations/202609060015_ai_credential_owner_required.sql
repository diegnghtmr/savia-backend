begin;

do $$
declare
  invalid_default_count integer;
begin
  select count(*)::integer into invalid_default_count
    from public.ai_default_models default_model
    left join public.ai_credentials credential
      on credential.id = default_model.credential_id
   where default_model.credential_id is not null
     and (credential.id is null
       or credential.workspace_id <> default_model.workspace_id
       or credential.owner_type <> 'workspace'
       or credential.status <> 'active');

  if invalid_default_count > 0 then
    raise exception 'ai default model invariant refused to install: % invalid default row(s); remediation: remove or replace each default with an active workspace-owned credential; secrets are never exposed or converted', invalid_default_count;
  end if;
end;
$$;

alter table public.ai_credentials
  add constraint ai_credentials_owner_required
  check (owner_type <> 'user' or created_by_subject_id is not null);

alter table public.ai_credentials
  add constraint ai_credentials_workspace_owner_key
  unique (id, workspace_id, owner_type);

alter table public.ai_default_models
  add column credential_owner_type text not null default 'workspace',
  add constraint ai_default_models_credential_owner_type_check
    check (credential_owner_type = 'workspace'),
  add constraint ai_default_models_credential_workspace_owner_fkey
    foreign key (credential_id, workspace_id, credential_owner_type)
    references public.ai_credentials (id, workspace_id, owner_type);

grant select on public.ai_credentials to savia_elevated;
grant select, delete on public.ai_default_models to savia_elevated;
grant delete on public.ai_default_models to savia_application;
create policy elevated_reads_ai_credentials
  on public.ai_credentials for select to savia_elevated using (true);
create policy elevated_reads_ai_defaults
  on public.ai_default_models for select to savia_elevated using (true);
grant usage, create on schema public to savia_elevated;

create function public.enforce_ai_default_active_credential()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  credential_status text;
begin
  if new.credential_id is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.credential_id::text, 0));
  select status into credential_status
    from public.ai_credentials
   where id = new.credential_id
     and workspace_id = new.workspace_id
     and owner_type = new.credential_owner_type;
  if credential_status is distinct from 'active' then
    raise exception 'ai default model requires an active workspace-owned credential'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
alter function public.enforce_ai_default_active_credential() owner to savia_elevated;

create function public.prevent_ai_credential_deactivation_with_default()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status <> 'active' and old.status = 'active' then
    perform pg_advisory_xact_lock(hashtextextended(new.id::text, 0));
    if exists (
      select 1 from public.ai_default_models
       where credential_id = new.id
         and workspace_id = new.workspace_id
    ) then
      raise exception 'ai credential cannot become inactive while selected as a default; clear the default first'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
alter function public.prevent_ai_credential_deactivation_with_default() owner to savia_elevated;

revoke create on schema public from savia_elevated;
revoke execute on function public.enforce_ai_default_active_credential() from public;
revoke execute on function public.prevent_ai_credential_deactivation_with_default() from public;

create trigger enforce_ai_default_active_credential_trigger
  after insert or update on public.ai_default_models
  for each row execute function public.enforce_ai_default_active_credential();
create trigger prevent_ai_credential_deactivation_with_default_trigger
  before update of status on public.ai_credentials
  for each row execute function public.prevent_ai_credential_deactivation_with_default();

commit;
