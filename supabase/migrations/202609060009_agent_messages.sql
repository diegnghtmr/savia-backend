begin;

alter table public.agent_conversations add column if not exists updated_at timestamptz not null default now();
grant update (updated_at) on public.agent_conversations to savia_application;
create policy agent_conversations_update_workspace on public.agent_conversations for update to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor')) with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor'));

create table public.agent_message_runs (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  created_by_subject_id uuid not null references auth.users(id) on delete cascade,
  message text not null,
  events jsonb not null,
  created_at timestamptz not null default now()
);
create table public.agent_message_idempotency (
  subject_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  idempotency_key text not null,
  request_fingerprint text not null,
  run_id uuid not null,
  events jsonb not null,
  created_at timestamptz not null default now(),
  primary key (subject_id, workspace_id, conversation_id, idempotency_key)
);
create table public.agent_message_rate_limits (
  subject_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (subject_id, workspace_id, conversation_id, window_start)
);
grant select, insert on public.agent_message_runs to savia_application;
grant select, insert, update on public.agent_message_idempotency to savia_application;
grant select, insert, update on public.agent_message_rate_limits to savia_application;
alter table public.agent_message_runs enable row level security;
alter table public.agent_message_runs force row level security;
alter table public.agent_message_idempotency enable row level security;
alter table public.agent_message_idempotency force row level security;
alter table public.agent_message_rate_limits enable row level security;
alter table public.agent_message_rate_limits force row level security;
create policy agent_message_runs_workspace on public.agent_message_runs for all to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer')) with check (created_by_subject_id=nullif(current_setting('app.subject_id',true),'')::uuid and public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer'));
create policy agent_message_idempotency_subject on public.agent_message_idempotency for all to savia_application using (subject_id=nullif(current_setting('app.subject_id',true),'')::uuid) with check (subject_id=nullif(current_setting('app.subject_id',true),'')::uuid);
create policy agent_message_rate_limit_subject on public.agent_message_rate_limits for all to savia_application using (subject_id=nullif(current_setting('app.subject_id',true),'')::uuid) with check (subject_id=nullif(current_setting('app.subject_id',true),'')::uuid);

create or replace function public.consume_agent_message_rate_limit(p_subject uuid, p_workspace uuid, p_conversation uuid, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := (date_trunc('minute', p_now at time zone 'UTC') at time zone 'UTC');
  v_count integer;
begin
  insert into public.agent_message_rate_limits(subject_id,workspace_id,conversation_id,window_start,request_count)
  values (p_subject,p_workspace,p_conversation,v_window,1)
  on conflict (subject_id,workspace_id,conversation_id,window_start)
  do update set request_count = agent_message_rate_limits.request_count + 1
  returning request_count into v_count;
  return v_count <= 20;
end $$;
revoke execute on function public.consume_agent_message_rate_limit(uuid,uuid,uuid,timestamptz) from public;
grant execute on function public.consume_agent_message_rate_limit(uuid,uuid,uuid,timestamptz) to savia_application;
commit;
