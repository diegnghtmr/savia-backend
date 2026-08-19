import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

/**
 * Scans an OpenAPI document for operations tagged with `x-financial: true`
 * that lack an `Idempotency-Key` header parameter.
 * @param {object} bundledDocument Bundled OpenAPI document object
 * @returns {string[]} List of violating operation descriptions
 */
export function findIdempotencyViolations(bundledDocument) {
  if (!bundledDocument || typeof bundledDocument !== 'object') {
    return [];
  }

  const paths = bundledDocument.paths ?? {};
  const violations = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const pathParameters = Array.isArray(pathItem.parameters)
      ? pathItem.parameters
      : [];

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!operation || typeof operation !== 'object') continue;

      const isFinancial =
        operation['x-financial'] === true ||
        operation['x-financial'] === 'true';
      if (!isFinancial) continue;

      const opParameters = Array.isArray(operation.parameters)
        ? operation.parameters
        : [];
      const allParameters = [...pathParameters, ...opParameters];

      const hasIdempotencyKey = allParameters.some(
        (param) =>
          param &&
          typeof param === 'object' &&
          param.in === 'header' &&
          typeof param.name === 'string' &&
          param.name.toLowerCase() === 'idempotency-key',
      );

      if (!hasIdempotencyKey) {
        const opName = operation.operationId
          ? `${method.toUpperCase()} ${path} (${operation.operationId})`
          : `${method.toUpperCase()} ${path}`;
        violations.push(opName);
      }
    }
  }

  return violations;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = resolve(import.meta.dirname, '..');
  const contractPath = 'openapi/savia.openapi.yaml';

  const directory = mkdtempSync(join(tmpdir(), 'savia-idempotency-'));
  const output = join(directory, 'contract.json');

  let bundledDocument;
  try {
    execFileSync(
      resolve(root, 'node_modules/.bin/redocly'),
      [
        'bundle',
        resolve(root, contractPath),
        '--ext',
        'json',
        '--output',
        output,
      ],
      { cwd: root, stdio: 'pipe' },
    );
    bundledDocument = JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }

  const violations = findIdempotencyViolations(bundledDocument);
  if (violations.length > 0) {
    throw new Error(
      `Financial idempotency violations found (rule 6 - missing Idempotency-Key):\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  process.stdout.write(
    'Financial idempotency rules verified: no violations found.\n',
  );
}
