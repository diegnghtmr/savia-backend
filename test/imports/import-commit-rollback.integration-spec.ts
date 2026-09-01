// Migrations under test: 202608310005_import_jobs.sql, 202608310006_import_commit_rollback.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportService } from '../../src/imports/import.service.js';
import { PostgresImportAdapter } from '../../src/imports/postgres-import.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { PostgresJobsAdapter } from '../../src/jobs/postgres-jobs.adapter.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { IMPORT_COMMIT_CALLBACK_TIMEOUT_MS } from '../../src/imports/import.service.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import type { JobWriter } from '../../src/platform/job-writer.port.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
const subject = '00000000-0000-0000-0000-000000005601';
const workspace = '00000000-0000-4000-8000-000000005601';
const account = '00000000-0000-4000-8000-000000005602';
const otherWorkspace = '00000000-0000-4000-8000-000000005603';
const otherSubject = '00000000-0000-0000-0000-000000005604';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('import commit and rollback against real PostgreSQL', () => {
  let admin: Pool;
  let service: ImportService;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    const pool = new PostgresPool(PostgresConfig.fromUrl(url));
    service = new ImportService(
      new PgTransaction(pool),
      new PostgresImportAdapter(),
      new PostgresIdempotencyAdapter(),
      new PostgresJobsAdapter() as unknown as JobWriter,
      new PostgresTransactionAdapter(),
      new PgTransaction(pool, {
        callbackTimeoutMs: IMPORT_COMMIT_CALLBACK_TIMEOUT_MS,
      }),
    );
    await admin.query(
      'insert into auth.users (id,email) values ($1,$2),($3,$4)',
      [subject, 'commit@example.test', otherSubject, 'foreign@example.test'],
    );
    await admin.query(
      "insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,$2,'Commit','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($3,$4,'Foreign','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD')",
      [subject, 'commit@example.test', otherSubject, 'foreign@example.test'],
    );
    await admin.query(
      "insert into public.workspaces (id,name,kind,base_currency) values ($1,'Commit workspace','shared','USD'),($2,'Foreign workspace','shared','USD')",
      [workspace, otherWorkspace],
    );
    await admin.query(
      "insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$2,'owner','active'),($3,$4,'owner','active')",
      [workspace, subject, otherWorkspace, otherSubject],
    );
    await admin.query(
      "insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$2,'owner','active')",
      [workspace, otherSubject],
    );
    await admin.query(
      "insert into public.accounts (id,workspace_id,name,type,currency,status,created_by) values ($1,$2,'Checking','checking','USD','active',$3)",
      [account, workspace, subject],
    );
  });
  afterAll(async () => {
    await admin.query('delete from public.workspaces where id in ($1,$2)', [
      workspace,
      otherWorkspace,
    ]);
    await admin.query('delete from auth.users where id in ($1,$2)', [
      subject,
      otherSubject,
    ]);
    await admin.end();
  });

  async function seedImport(
    number: number,
    status = 'awaiting_mapping',
    values: readonly unknown[][] = [['2026-01-01', 100, 'Coffee']],
    columns: readonly string[] = ['date', 'amount', 'description'],
  ): Promise<string> {
    const importId = id(number);
    await admin.query(
      'insert into public.import_jobs (id,workspace_id,file_name,status,source_columns,created_by) values ($1,$2,$3,$4,$5,$6)',
      [importId, workspace, `commit-${number}.csv`, status, columns, subject],
    );
    for (let index = 0; index < values.length; index += 1)
      await admin.query(
        "insert into public.import_job_rows (workspace_id,import_job_id,row_number,raw_values,parsed_date,parsed_amount_minor,parsed_description,classification) values ($1,$2,$3,$4,'2026-01-01',$5,$6,'valid')",
        [
          workspace,
          importId,
          index + 2,
          JSON.stringify(values[index]),
          Number(values[index][1]),
          String(values[index][2]),
        ],
      );
    return importId;
  }
  const mapping = {
    date: 'date',
    amount: 'amount',
    description: 'description',
  };
  async function amounts(importId: string) {
    return (
      await admin.query(
        'select amount_minor::text as amount from public.transactions where import_job_id=$1 order by id',
        [importId],
      )
    ).rows.map((row) => row.amount);
  }

  it('commits CSV rows with balanced postings and import traceability', async () => {
    const importId = await seedImport(5601, 'awaiting_mapping', [
      ['2026-01-01', 100, 'Coffee'],
      ['2026-01-02', -25, 'Refund'],
    ]);
    const result = await service.commitImport(
      subject,
      workspace,
      importId,
      {
        accountId: account,
        columnMapping: mapping,
        skipDuplicateCandidates: false,
      },
      key(5601),
    );
    expect(result.kind).toBe('ok');
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.transactions where import_job_id=$1',
          [importId],
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.ledger_postings p join public.transactions t on t.id=p.transaction_id where t.import_job_id=$1 and p.amount_minor is not null group by p.transaction_id having sum(p.amount_minor) <> 0',
          [importId],
        )
      ).rows,
    ).toHaveLength(0);
    const job = await admin.query(
      'select type,status,result_resource_id,progress_percent,completed_at from public.jobs where result_resource_id=$1',
      [importId],
    );
    expect(job.rows[0]).toMatchObject({
      type: 'import_commit',
      status: 'completed',
      result_resource_id: importId,
      progress_percent: 100,
    });
    expect(job.rows[0].completed_at).not.toBeNull();
  });

  it.each([
    ['negative', 100],
    ['positive', -100],
    ['separate_column', -100],
  ] as const)(
    'RULING 110 %s produces amount_minor %s',
    async (debitSign, expected) => {
      const importId = await seedImport(
        5710 +
          (debitSign === 'positive'
            ? 1
            : debitSign === 'separate_column'
              ? 2
              : 0),
        'awaiting_mapping',
        [['2026-01-01', 100, 'Sign', 'debit']],
        debitSign === 'separate_column'
          ? ['date', 'amount', 'description', 'debit']
          : undefined,
      );
      const command =
        debitSign === 'separate_column'
          ? {
              accountId: account,
              columnMapping: {
                date: 'date',
                amount: 'amount',
                description: 'description',
                debit: 'debitCreditIndicator',
              },
              debitSign,
              skipDuplicateCandidates: false,
            }
          : {
              accountId: account,
              columnMapping: mapping,
              debitSign,
              skipDuplicateCandidates: false,
            };
      const result = await service.commitImport(
        subject,
        workspace,
        importId,
        command,
        key(Number(importId.slice(-4))),
      );
      expect(result.kind).toBe('ok');
      expect(await amounts(importId)).toEqual([String(expected)]);
    },
  );

  it.each([
    ['debit', -100],
    ['credit', 100],
    ['D', -100],
    ['C', 100],
    ['DR', -100],
    ['CR', 100],
    ['Db', -100],
    ['Débito', -100],
    ['Crédito', 100],
    ['Cargo', -100],
    ['Abono', 100],
  ] as const)(
    'accepts separate-column indicator %s',
    async (indicator, expected) => {
      const number =
        5720 +
        (expected < 0 ? 0 : 20) +
        [
          'debit',
          'credit',
          'D',
          'C',
          'DR',
          'CR',
          'Db',
          'Débito',
          'Crédito',
          'Cargo',
          'Abono',
        ].indexOf(indicator);
      const importId = await seedImport(
        number,
        'awaiting_mapping',
        [['2026-01-01', 100, indicator, indicator]],
        ['date', 'amount', 'description', 'indicator'],
      );
      const result = await service.commitImport(
        subject,
        workspace,
        importId,
        {
          accountId: account,
          columnMapping: {
            date: 'date',
            amount: 'amount',
            description: 'description',
            indicator: 'debitCreditIndicator',
          },
          debitSign: 'separate_column',
          skipDuplicateCandidates: false,
        },
        key(number),
      );
      expect(result.kind).toBe('ok');
      expect(await amounts(importId)).toEqual([String(expected)]);
    },
  );

  it.each(['unknown', '  '])(
    'rejects blank or unknown indicator atomically (%s)',
    async (indicator) => {
      const number = indicator === 'unknown' ? 5801 : 5802;
      const importId = await seedImport(
        number,
        'awaiting_mapping',
        [['2026-01-01', 100, 'Invalid', indicator]],
        ['date', 'amount', 'description', 'indicator'],
      );
      const result = await service.commitImport(
        subject,
        workspace,
        importId,
        {
          accountId: account,
          columnMapping: {
            date: 'date',
            amount: 'amount',
            description: 'description',
            indicator: 'debitCreditIndicator',
          },
          debitSign: 'separate_column',
          skipDuplicateCandidates: false,
        },
        key(number),
      );
      expect(result.kind).toBe('invalid');
      expect(
        (
          await admin.query(
            'select count(*)::int as count from public.transactions where import_job_id=$1',
            [importId],
          )
        ).rows[0].count,
      ).toBe(0);
    },
  );

  it('uses the existing transaction duplicate identity only when skipping is enabled', async () => {
    await admin.query(
      "insert into public.transactions (id,workspace_id,account_id,type,status,amount_minor,currency,occurred_at,description,created_by) values ($1,$2,$3,'income','confirmed',100,'USD','2026-01-01','  COFFEE  ',$4)",
      [id(5620), workspace, account, subject],
    );
    const skipped = await seedImport(5621);
    const imported = await seedImport(5622);
    await service.commitImport(
      subject,
      workspace,
      skipped,
      {
        accountId: account,
        columnMapping: mapping,
        skipDuplicateCandidates: true,
      },
      key(5621),
    );
    await service.commitImport(
      subject,
      workspace,
      imported,
      {
        accountId: account,
        columnMapping: mapping,
        skipDuplicateCandidates: false,
      },
      key(5622),
    );
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.transactions where import_job_id=$1',
          [skipped],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.transactions where import_job_id=$1',
          [imported],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it.each([
    [{ amount: 'amount', description: 'description' }, 5631],
    [
      {
        date: 'date',
        amount: 'amount',
        description: 'description',
        nope: 'unknown',
      },
      5632,
    ],
    [{ date: 'missing', amount: 'amount', description: 'description' }, 5633],
  ])('rejects invalid mapping (%s)', async (columnMapping, number) => {
    const importId = await seedImport(number);
    const result = await service.commitImport(
      subject,
      workspace,
      importId,
      { accountId: account, columnMapping },
      key(number),
    );
    expect(result.kind).toBe('invalid');
  });

  it('honours supported dateFormat and rejects unsupported dateFormat', async () => {
    const supported = await seedImport(5641, 'awaiting_mapping', [
      ['01/02/2026', 100, 'Date'],
    ]);
    await admin.query(
      'update public.import_jobs set source_columns=$3 where id=$1 and workspace_id=$2',
      [supported, workspace, ['date', 'amount', 'description']],
    );
    expect(
      (
        await service.commitImport(
          subject,
          workspace,
          supported,
          {
            accountId: account,
            columnMapping: mapping,
            dateFormat: 'MM/DD/YYYY',
          },
          key(5641),
        )
      ).kind,
    ).toBe('ok');
    const unsupported = await seedImport(5642);
    expect(
      (
        await service.commitImport(
          subject,
          workspace,
          unsupported,
          {
            accountId: account,
            columnMapping: mapping,
            dateFormat: 'DD.MM.YYYY',
          },
          key(5642),
        )
      ).kind,
    ).toBe('invalid');
  });

  it('returns 409 outcomes for invalid state transitions and second rollback', async () => {
    const processing = await seedImport(5651, 'processing');
    expect(
      (
        await service.commitImport(
          subject,
          workspace,
          processing,
          {
            accountId: account,
            columnMapping: mapping,
            skipDuplicateCandidates: false,
          },
          key(5651),
        )
      ).kind,
    ).toBe('invalid');
    const awaiting = await seedImport(5652);
    expect(
      (await service.rollbackImport(subject, workspace, awaiting, key(5652)))
        .kind,
    ).toBe('invalid');
    const completed = await seedImport(5653);
    await service.commitImport(
      subject,
      workspace,
      completed,
      {
        accountId: account,
        columnMapping: mapping,
        skipDuplicateCandidates: false,
      },
      key(5653),
    );
    await service.rollbackImport(subject, workspace, completed, key(5654));
    expect(
      (await service.rollbackImport(subject, workspace, completed, key(5655)))
        .kind,
    ).toBe('conflict');
  });

  it('rolls back by voiding, skips voided, and blocks reconciled transactions atomically', async () => {
    const importId = await seedImport(5661, 'awaiting_mapping', [
      ['2026-01-01', 100, 'Coffee'],
      ['2026-01-02', 200, 'Salary'],
      ['2026-01-03', 300, 'Rent'],
    ]);
    await service.commitImport(
      subject,
      workspace,
      importId,
      {
        accountId: account,
        columnMapping: mapping,
        skipDuplicateCandidates: false,
      },
      key(5661),
    );
    const postingsBeforeRollback = await admin.query(
      'select count(*)::int as count from public.ledger_postings p join public.transactions t on t.id=p.transaction_id where t.import_job_id=$1',
      [importId],
    );
    await service.rollbackImport(subject, workspace, importId, key(5662));
    expect(
      (
        await admin.query(
          'select status from public.transactions where import_job_id=$1',
          [importId],
        )
      ).rows[0].status,
    ).toBe('voided');
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.ledger_postings p join public.transactions t on t.id=p.transaction_id where t.import_job_id=$1',
          [importId],
        )
      ).rows[0].count,
    ).toBe(postingsBeforeRollback.rows[0].count + 6);
    const reconciled = await seedImport(5662, 'awaiting_mapping', [
      ['2026-01-01', 100, 'Reconciled'],
      ['2026-01-02', 200, 'Not reconciled'],
      ['2026-01-03', 300, 'Also not reconciled'],
    ]);
    await service.commitImport(
      subject,
      workspace,
      reconciled,
      {
        accountId: account,
        columnMapping: mapping,
        skipDuplicateCandidates: false,
      },
      key(5663),
    );
    await admin.query(
      "update public.transactions set status='reconciled' where import_job_id=$1 and description='Reconciled'",
      [reconciled],
    );
    expect(
      (await service.rollbackImport(subject, workspace, reconciled, key(5664)))
        .kind,
    ).toBe('invalid');
    expect(
      (
        await admin.query(
          "select count(*)::int as count from public.transactions where import_job_id=$1 and status='voided'",
          [reconciled],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "select count(*)::int as count from public.ledger_postings p join public.transactions t on t.id=p.transaction_id where t.import_job_id=$1 and p.status='voided'",
          [reconciled],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it('rejects rollback after account closure without any compensating writes', async () => {
    const importId = await seedImport(5665, 'awaiting_mapping', [
      ['2026-01-01', 100, 'Closed'],
    ]);
    await service.commitImport(
      subject,
      workspace,
      importId,
      {
        accountId: account,
        columnMapping: mapping,
        skipDuplicateCandidates: false,
      },
      key(5665),
    );
    const before = await admin.query(
      'select (select count(*) from public.ledger_postings) as postings, (select count(*) from public.jobs where result_resource_id=$1) as jobs',
      [importId],
    );
    await admin.query(
      "update public.accounts set status='closed',closed_at=now() where id=$1",
      [account],
    );
    expect(
      (await service.rollbackImport(subject, workspace, importId, key(5666)))
        .kind,
    ).toBe('account-closed');
    const after = await admin.query(
      "select (select count(*) from public.ledger_postings) as postings, (select count(*) from public.jobs where result_resource_id=$1) as jobs, (select status from public.import_jobs where id=$1) as status, (select count(*) from public.transactions where import_job_id=$1 and status='voided') as voided",
      [importId],
    );
    expect(after.rows[0]).toMatchObject({
      postings: before.rows[0].postings,
      jobs: before.rows[0].jobs,
      status: 'completed',
      voided: '0',
    });
    await admin.query(
      "update public.accounts set status='active',closed_at=null where id=$1",
      [account],
    );
  });

  it('serializes different subjects so only one concurrent commit succeeds', async () => {
    const importId = await seedImport(5667);
    const command = {
      accountId: account,
      columnMapping: mapping,
      skipDuplicateCandidates: false,
    };
    const results = await Promise.all([
      service.commitImport(subject, workspace, importId, command, key(5667)),
      service.commitImport(
        otherSubject,
        workspace,
        importId,
        command,
        key(5668),
      ),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      'conflict',
      'ok',
    ]);
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.transactions where import_job_id=$1',
          [importId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.jobs where result_resource_id=$1',
          [importId],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it('serializes different subjects so only one concurrent rollback succeeds', async () => {
    const importId = await seedImport(5669, 'awaiting_mapping', [
      ['2026-01-01', 100, 'Concurrent rollback'],
      ['2026-01-02', 200, 'Concurrent rollback 2'],
    ]);
    const command = {
      accountId: account,
      columnMapping: mapping,
      skipDuplicateCandidates: false,
    };
    expect(
      (
        await service.commitImport(
          subject,
          workspace,
          importId,
          command,
          key(5669),
        )
      ).kind,
    ).toBe('ok');
    const results = await Promise.all([
      service.rollbackImport(subject, workspace, importId, key(5670)),
      service.rollbackImport(otherSubject, workspace, importId, key(5671)),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      'conflict',
      'ok',
    ]);
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.jobs where result_resource_id=$1',
          [importId],
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it('replays commit and rollback idempotently with one job and no duplicate import', async () => {
    const importId = await seedImport(5671);
    const command = {
      accountId: account,
      columnMapping: mapping,
      skipDuplicateCandidates: false,
    };
    await service.commitImport(
      subject,
      workspace,
      importId,
      command,
      key(5671),
    );
    await service.commitImport(
      subject,
      workspace,
      importId,
      command,
      key(5671),
    );
    await service.rollbackImport(subject, workspace, importId, key(5672));
    await service.rollbackImport(subject, workspace, importId, key(5672));
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.jobs where result_resource_id=$1',
          [importId],
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.transactions where import_job_id=$1',
          [importId],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it('commits the 10,000-row maximum without truncation', async () => {
    const importId = id(5691);
    await admin.query(
      "insert into public.import_jobs (id,workspace_id,file_name,status,source_columns,created_by) values ($1,$2,'maximum.csv','awaiting_mapping',ARRAY['date','amount','description'],$3)",
      [importId, workspace, subject],
    );
    await admin.query(
      "insert into public.import_job_rows (workspace_id,import_job_id,row_number,raw_values,parsed_date,parsed_amount_minor,parsed_description,classification) select $1,$2,g,jsonb_build_array('2026-01-01',g,'maximum-'||g),'2026-01-01',g,'maximum-'||g,'valid' from generate_series(2,10001) g",
      [workspace, importId],
    );
    const result = await service.commitImport(
      subject,
      workspace,
      importId,
      {
        accountId: account,
        columnMapping: mapping,
        skipDuplicateCandidates: false,
      },
      key(5691),
    );
    expect(result.kind).toBe('ok');
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.transactions where import_job_id=$1',
          [importId],
        )
      ).rows[0].count,
    ).toBe(10_000);
  }, 120_000);

  it('keeps the account lock across status read before committing', async () => {
    const importId = await seedImport(5692);
    const blocker = await admin.connect();
    await blocker.query('begin');
    await blocker.query(
      'select pg_advisory_xact_lock(hashtextextended($1,0))',
      [account],
    );
    const pending = service.commitImport(
      subject,
      workspace,
      importId,
      { accountId: account, columnMapping: mapping },
      key(5692),
    );
    await waitForAdvisoryWait(admin);
    await blocker.query(
      "update public.accounts set status='closed',closed_at=now() where id=$1",
      [account],
    );
    await blocker.query('commit');
    blocker.release();
    expect((await pending).kind).toBe('account-closed');
    await admin.query(
      "update public.accounts set status='active',closed_at=null where id=$1",
      [account],
    );
  });

  it('returns no result for a real foreign-workspace import', async () => {
    const foreign = id(5681);
    await admin.query(
      "insert into public.import_jobs (id,workspace_id,file_name,status,created_by) values ($1,$2,'foreign.csv','awaiting_mapping',$3)",
      [foreign, otherWorkspace, otherSubject],
    );
    expect(
      (
        await service.commitImport(
          subject,
          workspace,
          foreign,
          { accountId: account, columnMapping: mapping },
          key(5681),
        )
      ).kind,
    ).toBe('not-found');
  });

  it('proves rollback waits on the account advisory lock before reading status', async () => {
    const importId = await seedImport(5682);
    expect(
      (
        await service.commitImport(
          subject,
          workspace,
          importId,
          {
            accountId: account,
            columnMapping: mapping,
            skipDuplicateCandidates: false,
          },
          key(5682),
        )
      ).kind,
    ).toBe('ok');
    const blocker = await admin.connect();
    await blocker.query('begin');
    await blocker.query(
      'select pg_advisory_xact_lock(hashtextextended($1,0))',
      [account],
    );
    const pending = service.rollbackImport(
      subject,
      workspace,
      importId,
      key(5683),
    );
    await waitForAdvisoryWait(admin);
    await blocker.query('commit');
    blocker.release();
    expect((await pending).kind).toBe('ok');
  });
});

async function waitForAdvisoryWait(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query(
      "select 1 from pg_locks where locktype='advisory' and not granted limit 1",
    );
    if (result.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for an advisory lock waiter.');
}
