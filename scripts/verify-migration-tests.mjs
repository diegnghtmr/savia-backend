import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Recursively collects all files from the given directory,
 * ignoring .git, node_modules, dist, test/architecture, and fixtures.
 */
function collectSearchFiles(dir, collected = []) {
  if (!dir) return collected;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (['.git', 'node_modules', 'dist', 'fixtures'].includes(entry.name)) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    // Ignore test/architecture directory so fixture names inside architecture specs don't count as test references
    if (fullPath.includes('test/architecture')) {
      continue;
    }
    if (entry.isDirectory()) {
      collectSearchFiles(fullPath, collected);
    } else if (entry.isFile()) {
      collected.push(fullPath);
    }
  }
  return collected;
}

/**
 * Finds migrations in migrationsDir that are not referenced in any searchDirs.
 * @param {string} migrationsDir Directory containing migration .sql files
 * @param {string|string[]} searchDirs Directory or directories to search for references
 * @returns {string[]} List of untested migration basenames
 */
export function findUntestedMigrations(migrationsDir, searchDirs) {
  const dirs = Array.isArray(searchDirs) ? searchDirs : [searchDirs];

  let migrationFiles;
  try {
    migrationFiles = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  if (migrationFiles.length === 0) {
    return [];
  }

  // Collect all searchable test files
  const searchFiles = [];
  const normalizedMigrationsDir = resolve(migrationsDir);

  for (const dir of dirs) {
    const resolvedDir = resolve(dir);
    if (resolvedDir === normalizedMigrationsDir) continue;
    collectSearchFiles(resolvedDir, searchFiles);
  }

  // Read contents of all search files
  const searchContents = searchFiles.map((file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  });

  const untested = [];
  for (const migration of migrationFiles) {
    const isReferenced = searchContents.some((content) =>
      content.includes(migration),
    );
    if (!isReferenced) {
      untested.push(migration);
    }
  }

  return untested;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = resolve(import.meta.dirname, '..');
  const migrationsDir = resolve(root, 'supabase/migrations');
  const searchDirs = [
    resolve(root, 'test'),
    resolve(root, 'supabase/tests/database'),
  ];

  const untested = findUntestedMigrations(migrationsDir, searchDirs);
  if (untested.length > 0) {
    throw new Error(
      `Untested migrations found (rule 13):\n${untested.map((m) => `  - ${m}`).join('\n')}`,
    );
  }

  process.stdout.write(
    `Migration test coverage verified: all ${readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length} migrations referenced in tests.\n`,
  );
}
