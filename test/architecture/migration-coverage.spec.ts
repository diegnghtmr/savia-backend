import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUntestedMigrations } from '../../scripts/verify-migration-tests.mjs';

const root = process.cwd();

describe('architecture fitness functions (migration coverage - rule 13)', () => {
  it('rejects untested migrations using fixture (RED fixture)', () => {
    const fixtureDir = resolve(
      root,
      'test/architecture/fixtures/untested-migration',
    );
    const searchDirs = [
      resolve(root, 'test'),
      resolve(root, 'supabase/tests/database'),
    ];

    const untested = findUntestedMigrations(fixtureDir, searchDirs);

    expect(untested).toEqual(['202601010001_never_tested.sql']);
  });

  it('verifies all real migrations are referenced in tests (GREEN real tree)', () => {
    const realMigrationsDir = resolve(root, 'supabase/migrations');
    const searchDirs = [
      resolve(root, 'test'),
      resolve(root, 'supabase/tests/database'),
    ];

    const untested = findUntestedMigrations(realMigrationsDir, searchDirs);

    expect(untested).toEqual([]);
  });
});
