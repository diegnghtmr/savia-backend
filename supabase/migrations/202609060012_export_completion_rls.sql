begin;

grant update (status, object_path, download_url, expires_at, error, completed_at)
  on public.export_jobs to savia_application;

create policy application_updates_workspace_export_jobs on public.export_jobs
  for update to savia_application
  using (
    public.workspace_actor_active_role(export_jobs.workspace_id)
      in ('owner', 'administrator', 'editor')
    and export_jobs.status in ('queued', 'processing')
  )
  with check (
    public.workspace_actor_active_role(export_jobs.workspace_id)
      in ('owner', 'administrator', 'editor')
    and export_jobs.status in ('completed', 'failed')
  );

commit;
