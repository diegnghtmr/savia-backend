import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeTestGates,
  collectSetterSources,
  collectTestSources,
} from '../../scripts/verify-test-gates.mjs';

const root = resolve(process.cwd());

describe('test gate recurrence guard (dead-test-gate)', () => {
  it('detects un-set env variable gating a test via skipIf (case 1: detection)', () => {
    const source = `
const enabled = process.env.RUN_SCHEMA_CONTRACT === '1';
describe('x', () => {
  it.skipIf(!enabled)('does a thing', async () => {});
});
`;
    const testSources = [
      { path: 'test/schema/identity-tables.spec.ts', source },
    ];
    const setterSources: { path: string; source: string }[] = [];

    const analysis = analyzeTestGates(testSources, setterSources);

    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain('RUN_SCHEMA_CONTRACT');
    expect(analysis.violations[0]).toContain(
      'test/schema/identity-tables.spec.ts',
    );
  });

  it('ignores un-set env variable used in non-skip control flow (case 2: conjunction narrowing)', () => {
    const source = `
if (process.env.SAVIA_FORCE_POSTGRES_POOL_TEST_FAILURE === '1') {
  throw new Error('forced failure');
}
`;
    const testSources = [
      { path: 'test/identity/postgres-pool.integration-spec.ts', source },
    ];
    const setterSources: { path: string; source: string }[] = [];

    const analysis = analyzeTestGates(testSources, setterSources);

    expect(analysis.violations).toEqual([]);
  });

  it('accepts env-gated skip when variable has a setter in setterSources (case 3: setter lookup)', () => {
    const source = `
const url = process.env.WIRED_URL;
describe('x', () => {
  it.skipIf(!url)('does a thing', async () => {});
});
`;
    const testSources = [{ path: 'test/integration/wired.spec.ts', source }];
    const setterSources = [
      {
        path: 'scripts/run-tests.sh',
        source: 'WIRED_URL="$X" pnpm test',
      },
    ];

    const analysis = analyzeTestGates(testSources, setterSources);

    expect(analysis.violations).toEqual([]);
  });

  it('verifies real repository test gates (case 4: real tree, non-vacuous)', () => {
    const testSources = collectTestSources(root);
    const setterSources = collectSetterSources(root);

    const analysis = analyzeTestGates(testSources, setterSources);

    expect(analysis.violations).toEqual([]);
    expect(analysis.gates.length).toBeGreaterThanOrEqual(1);

    const resilienceGate = analysis.gates.find(
      (g) =>
        g.path.includes('pg-transaction-resilience.integration-spec.ts') &&
        g.variables.includes('DATABASE_URL'),
    );
    expect(resilienceGate).toBeDefined();
  });

  it('ignores commented-out setters (defect 1: commented setter)', () => {
    const source = `
const enabled = process.env.COMMENTED_OUT_VAR === '1';
describe('x', () => {
  it.skipIf(!enabled)('does a thing', async () => {});
});
`;
    const testSources = [{ path: 'test/gated.spec.ts', source }];
    const setterSources = [
      {
        path: 'scripts/example.sh',
        source: `#!/usr/bin/env bash\n# COMMENTED_OUT_VAR=1   # left here as an example\necho hello\n`,
      },
    ];

    const analysis = analyzeTestGates(testSources, setterSources);

    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain('COMMENTED_OUT_VAR');
  });

  it('detects un-set env variable gated via process.env object alias (defect 2: env alias)', () => {
    const source = `
const env = process.env;
describe('x', () => {
  it.skipIf(env.RUN_SCHEMA_CONTRACT !== '1')('...', () => {});
});
`;
    const testSources = [{ path: 'test/alias.spec.ts', source }];
    const setterSources: { path: string; source: string }[] = [];

    const analysis = analyzeTestGates(testSources, setterSources);

    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain('RUN_SCHEMA_CONTRACT');
  });
});
