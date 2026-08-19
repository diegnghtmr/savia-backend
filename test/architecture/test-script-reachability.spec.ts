import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeTestScriptReachability,
  collectPackageScripts,
  collectWorkflowSources,
  COVERAGE_ALLOWLIST,
} from '../../scripts/verify-test-script-reachability.mjs';

const root = resolve(process.cwd());

describe('unreachable test script recurrence guard (unreachable-test-script-gate)', () => {
  it('detects uninvoked test script (case 2: historical gap)', () => {
    const scripts = {
      'test:integration:bootstrap':
        'vitest run test/integration/bootstrap.spec.ts',
    };
    const workflowSources = [
      {
        path: '.github/workflows/ci.yml',
        source: '        run: pnpm test:integration:postgres-pool\n',
      },
    ];
    const allowList: { script: string; reason: string }[] = [];

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      allowList,
    );

    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain('test:integration:bootstrap');
  });

  it('resolves script chaining via BFS (case 3: chain resolution)', () => {
    const scripts = {
      test: 'vitest run',
      check: 'pnpm format:check && pnpm test && pnpm build',
    };
    const workflowSources = [
      {
        path: '.github/workflows/ci.yml',
        source: '        run: pnpm check\n',
      },
    ];
    const allowList: { script: string; reason: string }[] = [];

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      allowList,
    );

    expect(analysis.violations).toEqual([]);
    expect(analysis.reachable).toContain('test');
  });

  it('does not falsely match test prefix when specific script is invoked (case 4: the lookahead case)', () => {
    const scripts = {
      test: 'vitest run',
      'test:schema-contract': 'vitest run test/schema.spec.ts',
    };
    const workflowSources = [
      {
        path: '.github/workflows/ci.yml',
        source: '        run: pnpm test:schema-contract\n',
      },
    ];
    const allowList: { script: string; reason: string }[] = [];

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      allowList,
    );

    expect(analysis.reachable).not.toContain('test');
    expect(analysis.reachable).toContain('test:schema-contract');
    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain('test');
  });

  it('allows unreachable scripts if present in allow-list with reason (case 5: allow-list happy path)', () => {
    const scripts = {
      'test:database': 'vitest run test/db.spec.ts',
    };
    const workflowSources: { path: string; source: string }[] = [];
    const allowList = [
      {
        script: 'test:database',
        reason:
          'CI step database RLS contract runs identity_rls.test.sql inline',
      },
    ];

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      allowList,
    );

    expect(analysis.violations).toEqual([]);
    expect(analysis.allowListed).toEqual(['test:database']);
    expect(analysis.reachable).toEqual([]);
  });

  it('fails when allow-list entry has an empty reason (case 6: empty reason FAILS)', () => {
    const scripts = {
      'test:database': 'vitest run test/db.spec.ts',
    };
    const workflowSources: { path: string; source: string }[] = [];
    const allowList = [
      {
        script: 'test:database',
        reason: '',
      },
    ];

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      allowList,
    );

    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain('test:database');
    expect(analysis.violations[0].toLowerCase()).toContain('reason');
  });

  it('fails when allow-list entry names a non-existent script (case 7: stale: script gone)', () => {
    const scripts = {
      'test:unit': 'vitest run',
    };
    const workflowSources: { path: string; source: string }[] = [];
    const allowList = [
      {
        script: 'test:nonexistent',
        reason: 'Legacy script that was deleted',
      },
    ];

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      allowList,
    );

    expect(analysis.violations).toContain(
      "Allow-list entry 'test:nonexistent' is stale: no such script exists in package.json (unreachable-test-script-gate)",
    );
    expect(
      analysis.violations.some((v) => v.includes('no such script exists')),
    ).toBe(true);
  });

  it('fails when allow-list entry names a script directly or transitively invoked in CI (case 8: stale: now invoked)', () => {
    const scripts = {
      'test:integration:bootstrap':
        'vitest run test/integration/bootstrap.spec.ts',
    };
    const workflowSources = [
      {
        path: '.github/workflows/ci.yml',
        source: '        run: pnpm test:integration:bootstrap\n',
      },
    ];
    const allowList = [
      {
        script: 'test:integration:bootstrap',
        reason: 'Was once uninvoked',
      },
    ];

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      allowList,
    );

    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain(
      "Allow-list entry 'test:integration:bootstrap' is stale: script is now invoked by CI (unreachable-test-script-gate)",
    );
    expect(analysis.violations[0]).toContain('now invoked');
  });

  it('ignores commented-out invocations in workflow sources (case 9: commented-out CI line)', () => {
    const scripts = {
      'test:probe-x': 'vitest run test/probe-x.spec.ts',
    };
    const workflowSources = [
      {
        path: '.github/workflows/ci.yml',
        source: '      # - run: pnpm test:probe-x\n',
      },
    ];
    const allowList: { script: string; reason: string }[] = [];

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      allowList,
    );

    expect(analysis.violations).toHaveLength(1);
    expect(analysis.violations[0]).toContain('test:probe-x');
    expect(analysis.reachable).toEqual([]);
  });

  it('verifies real repository test script reachability (case 10: real tree, non-vacuous)', () => {
    const scripts = collectPackageScripts(root);
    const workflowSources = collectWorkflowSources(root);

    const analysis = analyzeTestScriptReachability(
      scripts,
      workflowSources,
      COVERAGE_ALLOWLIST,
    );

    expect(analysis.violations).toEqual([]);
    expect(analysis.checkedScripts.length).toBeGreaterThanOrEqual(9);
    expect(analysis.checkedScripts).toContain('test:integration:bootstrap');
  });
});
