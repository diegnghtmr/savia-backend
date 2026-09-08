begin;
create table public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by_subject_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  model_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_conversations_title_length_check check (char_length(title) <= 120)
);
create index agent_conversations_workspace_created_at_id_idx on public.agent_conversations(workspace_id,created_at,id);
alter table public.agent_conversations enable row level security;
alter table public.agent_conversations force row level security;
grant select,insert on public.agent_conversations to savia_application;
create policy agent_conversations_select_workspace on public.agent_conversations for select to savia_application using (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor','viewer'));
create policy agent_conversations_insert_workspace on public.agent_conversations for insert to savia_application with check (public.workspace_actor_active_role(workspace_id) in ('owner','administrator','editor') and created_by_subject_id=nullif(current_setting('app.subject_id',true),'')::uuid);
commit;
