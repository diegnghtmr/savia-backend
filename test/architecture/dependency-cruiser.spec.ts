import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const depcruiseBin = resolve(
  root,
  'node_modules/dependency-cruiser/bin/dependency-cruise.mjs',
);
const configFile = resolve(root, '.dependency-cruiser.cjs');

interface DepcruiseResult {
  status: number;
  output: string;
}

interface ExecErrorWithOutput {
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

function isExecErrorWithOutput(error: unknown): error is ExecErrorWithOutput {
  return typeof error === 'object' && error !== null;
}

function runDepcruise(fixtureDir: string): DepcruiseResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [depcruiseBin, '--config', configFile, '--output-type', 'err', 'src'],
      {
        cwd: fixtureDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, output: stdout };
  } catch (error: unknown) {
    if (isExecErrorWithOutput(error)) {
      const stdout =
        typeof error.stdout === 'string'
          ? error.stdout
          : (error.stdout?.toString() ?? '');
      const stderr =
        typeof error.stderr === 'string'
          ? error.stderr
          : (error.stderr?.toString() ?? '');
      const output = `${stdout}\n${stderr}\n${error.message ?? ''}`;
      return {
        status: error.status ?? 1,
        output,
      };
    }
    throw error;
  }
}

describe('architecture fitness functions (dependency-cruiser)', () => {
  it('rejects cross-module import from health to identity (rule 3: identity-health-isolation)', () => {
    const fixtureDir = resolve(
      root,
      'test/architecture/fixtures/deep-import-violation',
    );
    const result = runDepcruise(fixtureDir);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('identity-health-isolation');
    expect(result.output).toContain('src/health/leaks.ts');
    expect(result.output).toContain('src/identity/internal.ts');
  });

  it('rejects circular dependencies within a module (rule 4: no-circular)', () => {
    const fixtureDir = resolve(
      root,
      'test/architecture/fixtures/cycle-violation',
    );
    const result = runDepcruise(fixtureDir);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('no-circular');
    expect(result.output).toContain('src/identity/a.ts');
    expect(result.output).toContain('src/identity/b.ts');
  });
});
