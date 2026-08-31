begin;
insert into storage.buckets (id, name, public) values ('exports', 'exports', false) on conflict (id) do update set public = false;
grant usage on schema storage to savia_application;
grant select on storage.objects to savia_application;
create policy application_reads_workspace_export_objects on storage.objects
  for select to savia_application using (
    bucket_id = 'exports'
    and split_part(name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and public.workspace_actor_active_role(split_part(name, '/', 1)::uuid) in ('owner', 'administrator', 'editor', 'viewer')
  );
commit;
