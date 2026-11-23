begin;

-- The queue role gets a deletion decision, never table access or signed URLs.
grant select (id, workspace_id, job_id, download_url, expires_at)
  on public.workspace_backups to savia_elevated;
create policy workspace_backups_elevated_retention_read
  on public.workspace_backups for select to savia_elevated using (true);

create function public.can_remove_workspace_backup_object(
  p_workspace_id uuid, p_backup_id uuid, p_attempt_id uuid
) returns boolean
language sql stable strict security definer
set search_path = pg_catalog, public
as $$
  -- A missing backup cannot publish this randomly generated backup ID.
  select coalesce((
    select case
      when j.status is null or j.status not in ('completed', 'failed', 'cancelled', 'dead_letter')
        then false
      when b.expires_at is null or b.expires_at <= statement_timestamp()
        then true
      -- Reuse the exact unescaped ASCII path suffix validated by the signer;
      -- ignore the token. Unexpected live URLs fail closed for the prefix.
      else coalesce(
        substring(split_part(b.download_url, '?', 1) from
          '/(backups/' || p_workspace_id::text || '/' || p_backup_id::text ||
          '/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.zip)$'
        ) <> 'backups/' || p_workspace_id::text || '/' || p_backup_id::text || '/' || p_attempt_id::text || '.zip',
        false
      )
    end
    from public.workspace_backups b
    left join public.jobs j on (j.workspace_id, j.id) = (b.workspace_id, b.job_id)
    where b.workspace_id = p_workspace_id and b.id = p_backup_id
  ), true);
$$;

revoke all on function public.can_remove_workspace_backup_object(uuid, uuid, uuid) from public;
grant execute on function public.can_remove_workspace_backup_object(uuid, uuid, uuid) to savia_worker;

grant create on schema public to savia_elevated;
alter function public.can_remove_workspace_backup_object(uuid, uuid, uuid) owner to savia_elevated;
revoke create on schema public from savia_elevated;

commit;
