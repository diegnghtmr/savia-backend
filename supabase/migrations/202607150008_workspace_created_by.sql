begin;

alter table public.workspaces
  add column created_by uuid references public.profiles(id) on delete restrict;

comment on column public.workspaces.created_by is
  'Subject that created this workspace. Binds the first owner claim on collaborative workspaces so an ownerless workspace cannot be seized by an unrelated subject.';

commit;
