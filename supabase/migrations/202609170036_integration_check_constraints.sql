begin;

-- The full-backup migration replaced the job type check from recurring jobs.
-- Keep the combined worker's job types without changing either leaf migration.
alter table public.jobs
  drop constraint jobs_type_check,
  add constraint jobs_type_check check (type in (
    'import_commit', 'import_rollback', 'balance_forecast', 'report_run',
    'export_job', 'workspace_backup', 'receipt_ocr', 'recurring_materialization'
  ));

commit;
