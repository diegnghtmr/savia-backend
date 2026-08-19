import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
// Upper bound on `supabase stop` during cleanup. Well under the 600s test
// budget so a wedged CLI still leaves time for the workdir removal below.
const CLEANUP_TIMEOUT_MS = 60_000;
const runSupabase = (workdir: string, ...args: string[]) =>
  execFileAsync('pnpm', ['exec', 'supabase', '--workdir', workdir, ...args]);
const runPostgres = (port: number, file: string) =>
  execFileAsync(
    'psql',
    [
      '--no-password',
      '--set',
      'ON_ERROR_STOP=1',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--username',
      'postgres',
      '--dbname',
      'postgres',
      '--file',
      file,
    ],
    { env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
const queryPostgres = (port: number, query: string) =>
  execFileAsync(
    'psql',
    [
      '--no-password',
      '--tuples-only',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--username',
      'postgres',
      '--dbname',
      'postgres',
      '--command',
      query,
    ],
    { env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
const sourceRoot = process.cwd();
const schemaInputs = [
  'supabase/config.toml',
  'supabase/migrations/202607150001_identity_tables.sql',
  'supabase/migrations/202607150002_identity_rls.sql',
  'supabase/migrations/202607150003_identity_bootstrap_rls.sql',
  'supabase/migrations/202607150004_workspace_version.sql',
  'test/schema/workspace-version.contract.sql',
  'test/schema/workspace-version-upgrade.seed.sql',
  'test/schema/workspace-version-upgrade.contract.sql',
  'supabase/tests/database/identity_rls.test.sql',
  'supabase/tests/database/identity_bootstrap_rls.test.sql',
  // Appended rather than inserted so the existing indices stay stable. This is
  // the only coverage for the update and delete arms of
  // enforce_personal_workspace_owner_from_membership: the pgTAP suites above
  // exercise inserts only, so without this a change that let the sole owner be
  // moved or removed from their own personal workspace would go unnoticed.
  'test/schema/identity-tables.contract.sql',
] as const;
const targetInputs = [
  ...schemaInputs.slice(1),
  relative(sourceRoot, __filename),
];
const acceptedMigrationHashes = [
  'b05414027a8e7869953540927027dd13b4109026dd921b30c5e1801401b0d511',
  '0df686bef402c0b673b764d0c4487428d122b7c36f16d2b19b98db3aa31e62e8',
  '0778b2ef7e3c303b3c71d94fad3cbe6e6552370c1d4ae29c5fa33f969b5e58a2',
] as const;

// The Supabase CLI reports SQL failures on stdout, while execFile folds only
// stderr into the rejection message. Both helpers below therefore re-throw
// every channel; without that, a failing contract surfaces as an opaque
// "command failed" with the PL/pgSQL exception text discarded.
const surfaceAllChannels = (error: {
  message?: string;
  stdout?: string;
  stderr?: string;
}) =>
  new Error(
    [error.message, error.stdout, error.stderr].filter(Boolean).join('\n'),
  );
const execute = (workdir: string, ...args: string[]) =>
  runSupabase(workdir, ...args).then(
    ({ stdout }) => stdout,
    (error: { message?: string; stdout?: string; stderr?: string }) => {
      throw surfaceAllChannels(error);
    },
  );
const executeExpectingFailure = (workdir: string, ...args: string[]) =>
  runSupabase(workdir, ...args).then(
    () => {
      throw new Error('command succeeded but the contract required a failure');
    },
    (error: { message?: string; stdout?: string; stderr?: string }) => {
      throw surfaceAllChannels(error);
    },
  );
const copyInputs = (workdir: string) =>
  Promise.all(
    schemaInputs.map((input) =>
      cp(join(sourceRoot, input), join(workdir, input)),
    ),
  );
const targetState = () =>
  Promise.all(
    targetInputs.map((input) => readFile(join(sourceRoot, input), 'utf8')),
  );
const sha256 = (source: string) =>
  createHash('sha256').update(source).digest('hex');
const executeSchemaContract = async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'savia-schema-'));
  const projectId = `savia-schema-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const databasePort = 55_000 + Math.floor(Math.random() * 1_000);
  const originalTargetState = await targetState();
  expect(originalTargetState.slice(0, 3).map(sha256)).toEqual(
    acceptedMigrationHashes,
  );

  // Cleanup must survive a Vitest timeout, which fails the test without killing
  // in-flight children, and an external kill, which skips `finally` entirely.
  // Either one otherwise leaves the disposable Supabase project running and its
  // port bound. `stop` is raced against a bound so a wedged CLI cannot hang the
  // run indefinitely.
  const cleanup = async () => {
    await Promise.race([
      runSupabase(workdir, 'stop', '--no-backup').catch(() => undefined),
      delay(CLEANUP_TIMEOUT_MS, undefined, { ref: false }),
    ]);
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  };
  const onSignal = () => {
    void cleanup().finally(() => process.exit(1));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await Promise.all([
      mkdir(join(workdir, 'supabase/migrations'), { recursive: true }),
      mkdir(join(workdir, 'test/schema'), { recursive: true }),
      mkdir(join(workdir, 'supabase/tests/database'), { recursive: true }),
    ]);
    await copyInputs(workdir);
    const configPath = join(workdir, schemaInputs[0]);
    await writeFile(
      configPath,
      (await readFile(configPath, 'utf8'))
        .replace(/^project_id = .+$/m, `project_id = "${projectId}"`)
        .replace('[db]\n', `[api]\nport = ${databasePort + 1}\n\n[db]\n`)
        .replace(
          'major_version = 17',
          `major_version = 17\nport = ${databasePort}`,
        ),
    );
    await runSupabase(workdir, 'start');
    await runSupabase(workdir, 'db', 'reset', '--no-seed');
    await execute(
      workdir,
      'db',
      'query',
      '--local',
      '--file',
      join(workdir, schemaInputs[5]),
    );
    await execute(workdir, 'test', 'db', '--local', schemaInputs[8]);
    // Ownership invariants: sole-owner move and delete must not orphan a
    // personal workspace. It needs a clean database because the pgTAP suite
    // above leaves auth.users rows behind that share its fixture emails, and the
    // reset after it clears its own fixtures before the next suite runs.
    await runSupabase(workdir, 'db', 'reset', '--no-seed');
    await execute(
      workdir,
      'db',
      'query',
      '--local',
      '--file',
      join(workdir, schemaInputs[10]),
    );
    await runSupabase(workdir, 'db', 'reset', '--no-seed');
    await execute(workdir, 'test', 'db', '--local', schemaInputs[9]);
    await rm(join(workdir, schemaInputs[4]));
    await runSupabase(workdir, 'db', 'reset', '--no-seed');
    await expect(
      executeExpectingFailure(
        workdir,
        'db',
        'query',
        '--local',
        '--file',
        join(workdir, schemaInputs[5]),
      ),
    ).rejects.toThrow('workspace version metadata is incomplete');
    await execute(
      workdir,
      'db',
      'query',
      '--local',
      '--file',
      join(workdir, schemaInputs[6]),
    );
    await writeFile(
      join(workdir, schemaInputs[4]),
      (await readFile(join(sourceRoot, schemaInputs[4]), 'utf8')).replace(
        'commit;',
        'select 1 / 0;\ncommit;',
      ),
    );
    await expect(
      runPostgres(databasePort, join(workdir, schemaInputs[4])),
    ).rejects.toThrow();
    expect(
      (
        await queryPostgres(
          databasePort,
          "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'version'",
        )
      ).stdout,
    ).toContain('0');
    expect(
      (
        await queryPostgres(
          databasePort,
          "select name from public.workspaces where id = '00000000-0000-0000-0000-000000000403'",
        )
      ).stdout.trim(),
    ).toBe('Upgrade personal');
    await rm(join(workdir, schemaInputs[4]));
    await cp(join(sourceRoot, schemaInputs[4]), join(workdir, schemaInputs[4]));
    await runPostgres(databasePort, join(workdir, schemaInputs[4]));
    await execute(
      workdir,
      'db',
      'query',
      '--local',
      '--file',
      join(workdir, schemaInputs[7]),
    );
    expect(await targetState()).toEqual(originalTargetState);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
};

describe('identity tables database contract', () => {
  it('enforces personal ownership and existing table invariants with live writes', async () => {
    return executeSchemaContract();
  }, 600_000);
});
