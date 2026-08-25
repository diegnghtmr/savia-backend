import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Normalizes a SQL table name by stripping quotes and lowercasing.
 * @param {string} rawName
 * @returns {{ full: string, base: string }}
 */
function normalizeTableName(rawName) {
  const cleaned = rawName.replace(/"/g, '').trim().toLowerCase();
  const base = cleaned.includes('.') ? cleaned.split('.').pop() : cleaned;
  return { full: cleaned, base };
}

/**
 * Scans SQL source strings for tables tagged with 'fitness:financial'
 * that lack a 'workspace_id' column.
 * @param {string|string[]} sqlSources
 * @returns {string[]} List of violating table names
 */
export function findFinancialTableViolations(sqlSources) {
  const sources = Array.isArray(sqlSources) ? sqlSources : [sqlSources];
  const combinedSql = sources.join('\n;\n');

  // Strip block comments and line comments outside of strings
  const strippedSql = combinedSql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');

  // 1. Find all tables tagged with 'fitness:financial'
  const taggedTables = [];
  // SQL escapes a literal quote by doubling it (''), and the tag regex below
  // cannot span a quote character, so an ordinary apostrophe in a comment
  // ('Workspace''s financial account. fitness:financial') used to make the
  // statement unmatchable and silently dropped the table from this rule.
  // Collapse every doubled-quote escape inside a single-quoted literal to a
  // sentinel that is not a quote before matching. Only table names are kept
  // from the matches and identifiers never contain the sentinel, so no
  // restore pass is needed.
  const escapedQuoteSentinel = '\uE000';
  const normalisedSql = strippedSql.replace(/'(?:[^']|'')*'/g, (literal) =>
    literal.replaceAll("''", escapedQuoteSentinel),
  );
  const commentRegex =
    /comment\s+on\s+table\s+([a-zA-Z0-9_."]+)\s+is\s+['"]([^'"]*fitness:financial[^'"]*)['"]/gi;
  let commentMatch;
  while ((commentMatch = commentRegex.exec(normalisedSql)) !== null) {
    const rawName = commentMatch[1];
    taggedTables.push({
      rawName,
      ...normalizeTableName(rawName),
    });
  }

  if (taggedTables.length === 0) {
    return [];
  }

  // 2. Find all table definitions and check for workspace_id
  const tableHasWorkspaceId = new Map();

  const createTableRegex =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_."]+)\s*\(([\s\S]*?)\)(?:\s*;|\s*(?=create|alter|comment|insert|select|drop|$))/gi;
  let createMatch;
  while ((createMatch = createTableRegex.exec(strippedSql)) !== null) {
    const tableName = createMatch[1];
    const tableBody = createMatch[2];
    const normalized = normalizeTableName(tableName);
    const hasWorkspaceId = /\bworkspace_id\b/i.test(tableBody);

    tableHasWorkspaceId.set(normalized.full, hasWorkspaceId);
    tableHasWorkspaceId.set(normalized.base, hasWorkspaceId);
  }

  // Also check alter table ... add column workspace_id
  const alterTableRegex =
    /alter\s+table\s+([a-zA-Z0-9_."]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)/gi;
  let alterMatch;
  while ((alterMatch = alterTableRegex.exec(strippedSql)) !== null) {
    const tableName = alterMatch[1];
    const columnName = alterMatch[2];
    if (columnName.toLowerCase() === 'workspace_id') {
      const normalized = normalizeTableName(tableName);
      tableHasWorkspaceId.set(normalized.full, true);
      tableHasWorkspaceId.set(normalized.base, true);
    }
  }

  // 3. Collect violations
  const violations = [];
  for (const tagged of taggedTables) {
    const hasWorkspaceId =
      tableHasWorkspaceId.get(tagged.full) ||
      tableHasWorkspaceId.get(tagged.base);
    if (!hasWorkspaceId) {
      violations.push(tagged.rawName);
    }
  }

  return violations;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = resolve(import.meta.dirname, '..');
  const migrationsDir = resolve(root, 'supabase/migrations');

  let migrationFiles = [];
  try {
    migrationFiles = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    migrationFiles = [];
  }

  const sqlSources = migrationFiles.map((file) =>
    readFileSync(join(migrationsDir, file), 'utf8'),
  );

  const violations = findFinancialTableViolations(sqlSources);
  if (violations.length > 0) {
    throw new Error(
      `Financial table violations found (rule 5 - missing workspace_id):\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  process.stdout.write(
    'Financial table rules verified: no violations found.\n',
  );
}
