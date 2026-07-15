import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stdout } from 'node:process';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const fail = (message) => {
  throw new Error(`OpenAPI authority invalid: ${message}`);
};

const contractPath = 'openapi/savia.openapi.yaml';
const contract = read(contractPath);
const manifest = JSON.parse(read('openapi/implementation-manifest.json'));
const provenance = JSON.parse(read('openapi/provenance.json'));
const readme = read('README.md');
const digest = createHash('sha256').update(contract).digest('hex');
const planningSourceSha256 =
  '17aacf0dd0aab143d0fbaf8055d5f352c9af0895ffdeff523b0b53d8f3c69a69';
const ciLimitation =
  'Backend CI cannot access, authenticate, or independently re-hash this local source; it validates only these committed constants and executable contract identity.';
const httpMethods = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

const parseOpenApi = () => {
  const directory = mkdtempSync(join(tmpdir(), 'savia-openapi-'));
  const output = join(directory, 'contract.json');

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
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const findCopiedPlanningSource = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory() && findCopiedPlanningSource(path)) return path;
    if (
      entry.isFile() &&
      createHash('sha256').update(readFileSync(path)).digest('hex') ===
        planningSourceSha256
    ) {
      return path;
    }
  }
  return undefined;
};

const claimsCiCanVerifyPlanningSource = (content) =>
  /backend\s+ci\s+(?:can|will|does|has|is able to)\b[^\n]{0,120}\b(?:access|authenticate|re-?hash|verify)\b/i.test(
    content,
  );

const document = parseOpenApi();
const operations = Object.entries(document.paths ?? {}).flatMap(
  ([path, item]) =>
    Object.entries(item ?? {})
      .filter(([method]) => httpMethods.has(method.toLowerCase()))
      .map(([method, operation]) => ({
        method: method.toUpperCase(),
        operation,
        path,
      })),
);
const health = operations[0];

if (
  document.openapi !== '3.1.1' ||
  Object.keys(document.paths ?? {}).length !== 1 ||
  operations.length !== 1 ||
  health?.path !== '/health' ||
  health.method !== 'GET' ||
  health.operation?.operationId !== 'getHealth' ||
  !Array.isArray(health.operation?.security) ||
  health.operation.security.length !== 0
) {
  fail(
    'must publish exactly GET /health with operationId getHealth and no operation security',
  );
}
if (
  !health.operation.responses?.['200'] ||
  !health.operation.responses?.['503']
) {
  fail('must define /health 200 and reserved 503 responses');
}
if (
  readdirSync(resolve(root, 'openapi'), { withFileTypes: true }).some(
    (entry) =>
      !entry.isFile() ||
      ![
        'implementation-manifest.json',
        'provenance.json',
        'savia.openapi.yaml',
      ].includes(entry.name),
  ) ||
  findCopiedPlanningSource(root)
) {
  fail('planning source must not be copied into the backend');
}
if (
  manifest.executableContract !== contractPath ||
  manifest.clientGenerationInput !== contractPath
) {
  fail('manifest must use the executable contract as its sole client input');
}
if (
  JSON.stringify(manifest.implementedOperations) !==
  JSON.stringify([{ operationId: 'getHealth', method: 'GET', path: '/health' }])
) {
  fail('manifest must contain only GET /health');
}
if (
  provenance.executableContract?.path !== contractPath ||
  provenance.executableContract?.sha256 !== digest ||
  provenance.executableContract?.operationCount !== 1
) {
  fail('executable contract identity drifted');
}
const source = provenance.planningSource;
if (
  source?.revision !== 'f9f2a9489088d1bce7eeeedf4dd57b002ecaa883' ||
  source.path !== 'docs/savia-openapi.yaml' ||
  source.sha256 !== planningSourceSha256 ||
  source.bytes !== 160243 ||
  source.operationCount !== 93
) {
  fail('planning-source constants drifted');
}
if (
  provenance.backendCi?.planningSourceAccess !== ciLimitation ||
  !/Backend CI cannot access, authenticate, or independently\s+re-hash/.test(
    readme,
  ) ||
  claimsCiCanVerifyPlanningSource(JSON.stringify(provenance)) ||
  claimsCiCanVerifyPlanningSource(readme) ||
  claimsCiCanVerifyPlanningSource(JSON.stringify(manifest))
) {
  fail('backend CI must not claim local planning-source verification');
}

stdout.write('OpenAPI authority verified.\n');
