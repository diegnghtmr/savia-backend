import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  analyzeIntegrationShardAssignments,
  analyzeTestScriptReachability,
  collectPackageScripts,
} from '../../scripts/verify-test-script-reachability.mjs';

it('plans CI database and standalone OCR suites on the host', () => {
  const { status, stdout, stderr } = spawnSync(
    'node',
    [
      'scripts/integration-suite-plan.mjs',
      'ci',
      'forecasts',
      'receipt-ocr',
      'receipt-ocr-engine',
    ],
    { encoding: 'utf8' },
  );
  expect({ status, stdout, stderr }).toEqual({
    status: 0,
    stdout:
      'forecasts\thost-db\ttest/forecasts/forecasts.integration-spec.ts\n' +
      'receipt-ocr\thost-db\ttest/receipts/receipt-ocr.integration-spec.ts\n' +
      'receipt-ocr-engine\thost-standalone\ttest:integration:receipt-ocr-engine\n',
    stderr: '',
  });
});

it('rejects an empty CI selection before invoking the runner', () => {
  const { status, stdout, stderr } = spawnSync(
    'bash',
    ['scripts/run-integration-suites.sh', 'ci'],
    { encoding: 'utf8' },
  );
  expect({ status, stdout, stderr }).toEqual({
    status: 64,
    stdout: '',
    stderr: 'CI integration mode requires an explicit suite selection\n',
  });
});

it('preserves the local Docker OCR plan', () => {
  const { status, stdout, stderr } = spawnSync(
    'node',
    ['scripts/integration-suite-plan.mjs', 'ocr'],
    { encoding: 'utf8' },
  );
  expect({ status, stdout, stderr }).toEqual({
    status: 0,
    stdout:
      'forecasts\tcontainer-db\ttest/forecasts/forecasts.integration-spec.ts\n' +
      'receipt-ocr\tcontainer-db\ttest/receipts/receipt-ocr.integration-spec.ts\n' +
      'receipt-ocr-engine\tcontainer-standalone\ttest:integration:receipt-ocr-engine\n',
    stderr: '',
  });
});

it('recognizes only the named members of a literal CI batch', () => {
  const scripts = {
    'test:integration:workspace': 'vitest run workspace.spec.ts',
    'test:integration:profile': 'vitest run profile.spec.ts',
    'test:integration:pdf-renderer': 'vitest run pdf-renderer.spec.ts',
  };
  const result = analyzeTestScriptReachability(
    scripts,
    [
      {
        path: '.github/workflows/ci.yml',
        source: `      - name: batch\n        run: >-\n          bash scripts/run-integration-suites.sh ci\n          workspace profile\n`,
      },
    ],
    [],
  );
  expect(result.reachable).toEqual([
    'test:integration:workspace',
    'test:integration:profile',
  ]);
  expect(result.violations).toEqual([
    "Script 'test:integration:pdf-renderer' is not reachable from any CI workflow (unreachable-test-script-gate)",
  ]);
});

it('retries a CI registry rate limit, not a subsequent migration failure', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'savia-ci-start-'));
  try {
    const fake = (name: string, body: string) =>
      writeFileSync(join(scratch, name), '#!/usr/bin/env bash\n' + body, {
        mode: 0o700,
      });
    fake('flock', 'exit 0');
    fake('docker', 'exit 0');
    fake('node', '[[ "$2" == wait ]] || exec "$REAL_NODE" "$@"');
    fake('sleep', 'printf "delay %s\\n" "$1" >> "$TRACE"');
    fake(
      'pnpm',
      [
        'printf "%s\\n" "$5" >> "$TRACE"',
        'if [[ "$5" != start ]]; then exit 0; fi',
        'if [[ ! -e "$TMPDIR/attempted" ]]; then',
        '  touch "$TMPDIR/attempted"',
        '  printf "Data limit exceeded\\n" >&2',
        '  exit 1',
        'fi',
        'printf "ERROR: migration failed (SQLSTATE 42P01)\\n" >&2',
        'exit 78',
      ].join('\n'),
    );

    const trace = join(scratch, 'trace');
    const { status, stdout, stderr } = spawnSync(
      'bash',
      ['scripts/run-integration-suites.sh', 'ci', 'postgres-pool'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: scratch + ':' + process.env.PATH,
          TMPDIR: scratch,
          REAL_NODE: process.execPath,
          TRACE: trace,
        },
      },
    );
    expect(status).toBe(78);
    expect(stdout).toBe(
      '==> postgres-pool\n\nIntegration summary:\n  NOT RUN postgres-pool\n' +
        '0 passed, 0 failed, 1 not run\n',
    );
    const [first, second, end] = stderr.split('\n');
    const delay =
      /^Supabase image pull rate-limited \(attempt 1\); retrying in (\d+)s$/.exec(
        first,
      )?.[1];
    expect(Number(delay)).toBeGreaterThanOrEqual(45);
    expect(Number(delay)).toBeLessThanOrEqual(74);
    expect(second).toContain(
      'Supabase start failed (status 78); sanitized diagnostics retained at ',
    );
    expect(end).toBe('');
    expect(readFileSync(trace, 'utf8')).toBe(
      'start\nstop\ndelay ' + delay + '\nstart\nstop\n',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const scripts = collectPackageScripts(process.cwd());
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

it('checks that every actual suite and contract runs in exactly one shard', () => {
  expect(analyzeIntegrationShardAssignments(scripts, workflow)).toEqual([]);
});

it('rejects duplicate and missing suites, including inline SQL contracts', () => {
  const changed = workflow
    .replace('remove-workspace-member accounts-balance', 'accounts-balance')
    .replace(
      'postgres-pool update-workspace-member',
      'postgres-pool accounts-balance update-workspace-member',
    );
  const withoutRls = changed.replace(
    /^ {6}- name: database RLS contract\n[\s\S]*?(?=^ {6}- name: database bootstrap contract)/m,
    '',
  );
  expect(analyzeIntegrationShardAssignments(scripts, withoutRls)).toEqual([
    'test:integration:remove-workspace-member must run exactly once across CI shards; found 0',
    'test:integration:accounts-balance must run exactly once across CI shards; found 2 (shards 1, 5)',
    'test:database must run exactly once across CI shards; found 0',
  ]);
});

it('rejects a batch that would run on all shards', () => {
  const changed = workflow.replace(
    '      - name: run shard 1 suites\n        if: matrix.shard == 1\n',
    '      - name: run shard 1 suites\n',
  );
  expect(analyzeIntegrationShardAssignments(scripts, changed)).toContain(
    'Integration step must select exactly one matrix shard: name: run shard 1 suites',
  );
});
