import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

function run(args: string[], env = process.env) {
  const { status, stdout, stderr } = spawnSync(
    'bash',
    ['scripts/run-integration-suites.sh', ...args],
    { cwd: root, env, encoding: 'utf8' },
  );
  return { status, stdout: stdout.replace(/\b\d+s(?=\))/g, '<time>'), stderr };
}

it('lists all existing integration aliases and only the real OCR suites in OCR mode', () => {
  const all = Object.keys(packageJson.scripts).filter(
    (name) =>
      name.startsWith('test:integration:') &&
      !['test:integration:all', 'test:integration:ocr'].includes(name),
  );
  expect(run(['all', '--list'])).toEqual({
    status: 0,
    stdout: `${all.map((name) => name.slice('test:integration:'.length)).join('\n')}\n`,
    stderr: '',
  });
  expect(run(['ocr', '--list'])).toEqual({
    status: 0,
    stdout: 'forecasts\nreceipt-ocr\nreceipt-ocr-engine\n',
    stderr: '',
  });
});

it('rejects an invalid selection before doing any work', () => {
  expect(run(['ocr', 'postgres-pool'])).toEqual({
    status: 64,
    stdout: '',
    stderr: 'Unknown ocr integration suite: postgres-pool\n',
  });
});

const legacyRunner = 'scripts/run-disposable-database-suite.sh';
const legacySuites = Object.entries(packageJson.scripts).flatMap(
  ([name, command]) => {
    const [shell, runner, spec] = command.split(' ');
    return shell === 'bash' && runner === legacyRunner ? [{ name, spec }] : [];
  },
);

it.each(legacySuites)(
  '$name still rejects an extra runner argument',
  ({ spec }) => {
    const { status, stdout, stderr } = spawnSync(
      'bash',
      [legacyRunner, spec, '--list'],
      { cwd: root, encoding: 'utf8' },
    );
    expect({ status, stdout, stderr }).toEqual({
      status: 64,
      stdout: '',
      stderr: '',
    });
  },
);

it('starts once, resets for each DB suite, summarizes failures, and tears down once', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'savia-integration-runner-test-'));
  try {
    const trace = join(scratch, 'trace');
    const fake = (name: string, body: string) =>
      writeFileSync(join(scratch, name), `#!/usr/bin/env bash\n${body}\n`, {
        mode: 0o700,
      });
    fake('flock', 'printf "lock\\n" >> "$TRACE"');
    fake('docker', 'exit 0');
    fake(
      'pnpm',
      `case "$1 $2" in
  'exec supabase')
    printf '%s\\n' "\${*:5}" >> "$TRACE"
    if [[ "$5" == status ]]; then printf 'DB_URL=postgresql://fixture.invalid/fixture\\n'; fi
    ;;
  'exec vitest')
    [[ "$DATABASE_URL" == postgresql://fixture.invalid/fixture ]] || exit 70
    printf 'vitest %s\\n' "$6" >> "$TRACE"
    [[ "$6" != *postgres-pool* ]] || exit 7
    ;;
  *) exit 70 ;;
esac`,
    );
    const result = run(['all', 'postgres-pool', 'workspace'], {
      ...process.env,
      PATH: `${scratch}:${process.env.PATH}`,
      TRACE: trace,
    });
    expect(result).toEqual({
      status: 1,
      stdout:
        '==> postgres-pool\n==> workspace\n\nIntegration summary:\n' +
        '  FAIL postgres-pool (exit 7, <time>)\n  PASS workspace (<time>)\n' +
        '1 passed, 1 failed, 0 not run\n',
      stderr: '',
    });
    expect(readFileSync(trace, 'utf8')).toBe(
      'lock\nstart\nstatus -o env\ndb reset --no-seed\nvitest test/identity/postgres-pool.integration-spec.ts\n' +
        'db reset --no-seed\nvitest test/identity/workspace.integration-spec.ts\nstop --no-backup\n',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
