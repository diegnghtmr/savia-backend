begin;
create table public.ai_credentials (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 owner_type text not null, provider_id text not null, credential_type text not null, encrypted_secret text not null,
  masked_identifier text not null, alias text, metadata jsonb not null default '{}'::jsonb, created_by_subject_id uuid references auth.users(id), status text not null default 'active',
 last_used_at timestamptz, expires_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version integer not null default 0,
 constraint ai_credentials_owner_type_check check (owner_type in ('user','workspace')),
 constraint ai_credentials_type_check check (credential_type in ('api_key','service_account','access_token','gateway_token','local_endpoint','oauth')),
 constraint ai_credentials_status_check check (status in ('active','disabled','revoked')),
 constraint ai_credentials_alias_length_check check (alias is null or char_length(alias)<=120)
 );
 create unique index ai_credentials_unique_alias on public.ai_credentials
   (workspace_id,owner_type,provider_id,credential_type,alias,
    (case when owner_type = 'user' then created_by_subject_id else null end)) nulls not distinct;
create table public.ai_default_models (workspace_id uuid primary key references public.workspaces(id) on delete cascade, model_ref text not null, credential_id uuid, updated_at timestamptz not null default now());
alter table public.ai_credentials enable row level security; alter table public.ai_credentials force row level security;
alter table public.ai_default_models enable row level security; alter table public.ai_default_models force row level security;
grant select,insert,update on public.ai_credentials to savia_application; grant select,insert,update on public.ai_default_models to savia_application;
 create policy ai_credentials_select on public.ai_credentials for select to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer') and (owner_type <> 'user' or created_by_subject_id = nullif(current_setting('app.subject_id', true), '')::uuid));
 create policy ai_credentials_insert on public.ai_credentials for insert to savia_application with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator') and (owner_type <> 'user' or created_by_subject_id = nullif(current_setting('app.subject_id', true), '')::uuid));
 create policy ai_credentials_update on public.ai_credentials for update to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator') and (owner_type <> 'user' or created_by_subject_id = nullif(current_setting('app.subject_id', true), '')::uuid)) with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator') and (owner_type <> 'user' or created_by_subject_id = nullif(current_setting('app.subject_id', true), '')::uuid));
create policy ai_defaults_select on public.ai_default_models for select to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer'));
create policy ai_defaults_write on public.ai_default_models for all to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator')) with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator'));
commit;
