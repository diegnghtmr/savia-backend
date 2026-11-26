import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

it('starts once, resets DB and Storage for each suite, and tears down once', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'savia-integration-runner-test-'));
  try {
    const trace = join(scratch, 'trace');
    const fake = (name: string, body: string) =>
      writeFileSync(join(scratch, name), `#!/usr/bin/env bash\n${body}\n`, {
        mode: 0o700,
      });
    fake('flock', 'printf "lock\\n" >> "$TRACE"');
    fake('node', '[[ "$2" == wait ]] || exec "$REAL_NODE" "$@"');
    fake(
      'docker',
      `case "$1" in
  inspect)
    storage="$6"
    printf '%s volume:%s\\n' "\${storage#supabase_storage_}" "$storage"
    ;;
  volume)
    if [[ "$2" == inspect ]]; then
      [[ "$3 $4" == '--format {{index .Labels "com.supabase.cli.project"}}' ]] || exit 70
      printf '%s\\n' "\${5#supabase_storage_}"
    fi
    ;;
  exec)
    [[ "$2 $3" == supabase_storage_savia-integration-*' sh' ]] || exit 70
    printf 'storage wipe\\n' >> "$TRACE"
    ;;
esac`,
    );
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
      REAL_NODE: process.execPath,
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
      'lock\nstart\nstatus -o env\ndb reset --no-seed\nstorage wipe\nvitest test/identity/postgres-pool.integration-spec.ts\n' +
        'db reset --no-seed\nstorage wipe\nvitest test/identity/workspace.integration-spec.ts\nstop --no-backup\n',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it.each(['other-project', ''])(
  'preserves a correctly named Storage volume with project label %j',
  (owner) => {
    const scratch = mkdtempSync(join(tmpdir(), 'savia-storage-owner-'));
    try {
      const trace = join(scratch, 'trace');
      writeFileSync(trace, '');
      const fake = (name: string, body: string) =>
        writeFileSync(join(scratch, name), `#!/usr/bin/env bash\n${body}\n`, {
          mode: 0o700,
        });
      fake('flock', 'exit 0');
      fake('node', '[[ "$2" == wait ]] || exec "$REAL_NODE" "$@"');
      fake(
        'docker',
        `case "$1 $2 $3" in
  'inspect --type container')
    name="$6"
    printf '%s volume:%s\\n' "\${name#supabase_storage_}" "$name";;
  'volume inspect --format') printf '%s\\n' "$VOLUME_OWNER";;
  'volume rm '*) printf 'volume removed\\n' >> "$TRACE";;
  'exec '*) printf 'wipe\\n' >> "$TRACE";;
esac`,
      );
      fake(
        'pnpm',
        `case "$1 $2" in
  'exec supabase')
    case "$5" in
      status) printf 'DB_URL=postgresql://fixture.invalid/db\\n';;
      stop) printf 'CLI stop could remove unverified volume\\n' >> "$TRACE";;
    esac;;
  'exec vitest') printf 'suite\\n' >> "$TRACE";;
esac`,
      );
      expect(
        run(['all', 'postgres-pool'], {
          ...process.env,
          PATH: `${scratch}:${process.env.PATH}`,
          TMPDIR: scratch,
          REAL_NODE: process.execPath,
          TRACE: trace,
          VOLUME_OWNER: owner,
        }),
      ).toEqual({
        status: 1,
        stdout:
          '==> postgres-pool\n\nIntegration summary:\n' +
          '  NOT RUN postgres-pool\n0 passed, 0 failed, 1 not run\n',
        stderr:
          'Refusing to reset Storage: the mounted volume is not owned by the disposable project.\n' +
          'Aborting: clean Storage reset failed before postgres-pool.\n',
      });
      expect(readFileSync(trace, 'utf8')).toBe('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

it.each([
  {
    message: 'failed programming external connectivity: address already in use',
    retryStatus: 0,
    expectedStatus: 0,
    calls: 'wait\nstart\nstop\nwait\nstart\nstatus\ndb\nvitest\nstop\n',
  },
  {
    message: 'failed to bind: port is already allocated',
    retryStatus: 7,
    expectedStatus: 7,
    calls: 'wait\nstart\nstop\nwait\nstart\nstop\n',
  },
  {
    message:
      'failed programming external connectivity: iptables: Permission denied',
    retryStatus: 0,
    expectedStatus: 4,
    calls: 'wait\nstart\nstop\n',
  },
  {
    message: 'ERROR: migration failed (SQLSTATE 42P01)',
    retryStatus: 0,
    expectedStatus: 4,
    calls: 'wait\nstart\nstop\n',
  },
])('handles $message (retry status $retryStatus)', (scenario) => {
  const scratch = mkdtempSync(join(tmpdir(), 'savia-start-policy-test-'));
  try {
    const trace = join(scratch, 'trace');
    const fake = (name: string, body: string) =>
      writeFileSync(join(scratch, name), `#!/usr/bin/env bash\n${body}\n`, {
        mode: 0o700,
      });
    fake('docker', 'exit 0');
    fake(
      'node',
      `if [[ "$2" == wait ]]; then
  grep -qx '\\[realtime\\]' "$3" || exit 70
  printf 'wait\\n' >> "$TRACE"
else
  exec "$REAL_NODE" "$@"
fi`,
    );
    fake(
      'pnpm',
      `case "$1 $2" in
  'exec supabase')
    printf '%s\\n' "$5" >> "$TRACE"
    case "$5" in
      start)
        if [[ ! -e "$TMPDIR/attempted" ]]; then
          touch "$TMPDIR/attempted"
          printf '%s\\n' "$START_ERROR" >&2
          exit 4
        fi
        if [[ "$RETRY_STATUS" != 0 ]]; then
          printf '%s\\n' "$START_ERROR" >&2
          exit "$RETRY_STATUS"
        fi
        ;;
      status) printf 'DB_URL=postgresql://fixture.invalid/fixture\\n' ;;
    esac
    ;;
  'exec vitest') printf 'vitest\\n' >> "$TRACE" ;;
  *) exit 70 ;;
esac`,
    );
    const { status, stdout, stderr } = spawnSync(
      'bash',
      [legacyRunner, 'test/identity/postgres-pool.integration-spec.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${scratch}:${process.env.PATH}`,
          TMPDIR: scratch,
          TRACE: trace,
          REAL_NODE: process.execPath,
          START_ERROR: scenario.message,
          RETRY_STATUS: String(scenario.retryStatus),
        },
      },
    );
    expect(status).toBe(scenario.expectedStatus);
    expect(stdout).toBe('');
    expect(readFileSync(trace, 'utf8')).toBe(scenario.calls);
    const diagnostics = readdirSync(scratch).filter((name) =>
      name.startsWith('savia-start-failure-'),
    );
    if (scenario.expectedStatus === 0) {
      expect(stderr).toBe('');
      expect(diagnostics).toEqual([]);
    } else {
      expect(diagnostics).toHaveLength(1);
      const dir = join(scratch, diagnostics[0]);
      expect(stderr).toBe(
        `Supabase start failed (status ${scenario.expectedStatus}); sanitized diagnostics retained at ${dir}\n`,
      );
      expect(readFileSync(join(dir, 'start-errors.log'), 'utf8')).toBe(
        `supabase_start_status=${scenario.expectedStatus}\n${scenario.message}\n`,
      );
      expect(readFileSync(join(dir, 'cleanup-status'), 'utf8')).toBe(
        'owned_containers=absent\nworkdir=removed\n',
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
