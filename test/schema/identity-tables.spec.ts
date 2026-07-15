import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const runSupabase = (workdir: string, ...args: string[]) =>
  execFileAsync('pnpm', ['exec', 'supabase', '--workdir', workdir, ...args]);
const sourceRoot = process.cwd();
const schemaContractEnabled = process.env.RUN_SCHEMA_CONTRACT === '1';
const forceContractFailure = process.env.FORCE_SCHEMA_CONTRACT_FAILURE === '1';
const schemaInputs = [
  'supabase/config.toml',
  'supabase/migrations/202607150001_identity_tables.sql',
  'test/schema/identity-tables.contract.sql',
] as const;

const executeSchemaContract = async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'savia-schema-'));
  const projectId = `savia-schema-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const contractPath = join(workdir, schemaInputs[2]);

  try {
    await Promise.all([
      mkdir(join(workdir, 'supabase/migrations'), { recursive: true }),
      mkdir(join(workdir, 'test/schema'), { recursive: true }),
    ]);
    await Promise.all(
      schemaInputs.map((input) =>
        cp(join(sourceRoot, input), join(workdir, input)),
      ),
    );
    const configPath = join(workdir, schemaInputs[0]);
    await writeFile(
      configPath,
      (await readFile(configPath, 'utf8')).replace(
        /^project_id = .+$/m,
        `project_id = "${projectId}"`,
      ),
    );
    if (forceContractFailure) await writeFile(contractPath, 'select 1 / 0;');
    await runSupabase(workdir, 'start');
    await runSupabase(workdir, 'db', 'reset', '--no-seed');
    const queryArgs = ['db', 'query', '--local', '--file', contractPath];
    const { stdout } = await runSupabase(workdir, ...queryArgs);
    expect(stdout).toContain('DO');
  } finally {
    await runSupabase(workdir, 'stop', '--no-backup').catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });
  }
};

describe('identity tables database contract', () => {
  it.skipIf(!schemaContractEnabled)(
    'enforces personal ownership and existing table invariants with live writes',
    async () => {
      if (forceContractFailure)
        return expect(executeSchemaContract()).rejects.toThrow();
      return executeSchemaContract();
    },
    120_000,
  );
});
