begin;
alter table public.workspaces add column version integer;
update public.workspaces set version = 1 where version is null;
set constraints all immediate;
alter table public.workspaces alter column version set default 1;
alter table public.workspaces alter column version set not null;
alter table public.workspaces add constraint workspaces_version_gte_1 check (version >= 1);
commit;
