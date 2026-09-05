import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stdout } from 'node:process';
import { env } from 'node:process';

const packageRoot = resolve(import.meta.dirname, '..');
const root = env.OPENAPI_AUTHORITY_ROOT ?? packageRoot;
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
  'f591e81effa7d25dac3970407f31962140187ed3bb4d28a3ac9264d8c899b85a';
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
      resolve(packageRoot, 'node_modules/.bin/redocly'),
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
    if (['.git', 'dist', 'node_modules', '.codegraph'].includes(entry.name))
      continue;
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
const health = operations.find(
  (entry) => entry.path === '/health' && entry.method === 'GET',
);

const sortKeys = (val) => {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const sorted = {};
  for (const key of Object.keys(val).sort()) {
    sorted[key] = sortKeys(val[key]);
  }
  return sorted;
};

const findDifferingField = (actual, expected, path = '') => {
  if (actual === expected) return null;
  if (
    typeof actual !== 'object' ||
    actual === null ||
    typeof expected !== 'object' ||
    expected === null ||
    Array.isArray(actual) !== Array.isArray(expected)
  ) {
    return path || '(root)';
  }
  const allKeys = Array.from(
    new Set([...Object.keys(actual), ...Object.keys(expected)]),
  ).sort();
  for (const key of allKeys) {
    const fieldPath = path ? `${path}.${key}` : key;
    if (!(key in actual) || !(key in expected)) {
      return fieldPath;
    }
    const diff = findDifferingField(actual[key], expected[key], fieldPath);
    if (diff) return diff;
  }
  return null;
};

const sharedParameterTargets = [
  { name: 'limit', in: 'query' },
  { name: 'Idempotency-Key', in: 'header' },
  { name: 'cursor', in: 'query' },
  { name: 'X-Workspace-Id', in: 'header' },
];

// Pre-existing operations that omit explicit required: false on query parameters.
// Discovered during the whole-mirror audit for slice 7.3a; scoped for systemic cleanup
// in a dedicated round so the mirror is not touched piecemeal.
const sharedParameterRequiredAllowlist = new Set([
  'listBudgets:cursor:query',
  'listBudgets:limit:query',
  'listFunds:cursor:query',
  'listFunds:limit:query',
  'listDebts:cursor:query',
  'listDebts:limit:query',
]);

for (const target of sharedParameterTargets) {
  const occurrences = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!httpMethods.has(method.toLowerCase())) continue;
      const effective = new Map();
      for (const p of item.parameters ?? []) {
        if (p?.name && p?.in) effective.set(`${p.name}:${p.in}`, p);
      }
      for (const p of operation?.parameters ?? []) {
        if (p?.name && p?.in) effective.set(`${p.name}:${p.in}`, p);
      }
      const matched = effective.get(`${target.name}:${target.in}`);
      if (matched) {
        occurrences.push({
          operationId:
            operation.operationId ?? `${method.toUpperCase()} ${path}`,
          schema: matched.schema ?? {},
          required: matched.required,
        });
      }
    }
  }

  if (occurrences.length <= 1) continue;

  const frequencies = new Map();
  for (const occ of occurrences) {
    const ser = JSON.stringify(sortKeys(occ.schema));
    frequencies.set(ser, (frequencies.get(ser) ?? 0) + 1);
  }

  let baselineSer = null;
  let maxCount = -1;
  for (const [ser, count] of frequencies) {
    if (count > maxCount) {
      maxCount = count;
      baselineSer = ser;
    }
  }

  const baseline = occurrences.find(
    (occ) => JSON.stringify(sortKeys(occ.schema)) === baselineSer,
  );

  const requiredFrequencies = new Map();
  for (const occ of occurrences) {
    if (
      sharedParameterRequiredAllowlist.has(
        `${occ.operationId}:${target.name}:${target.in}`,
      )
    ) {
      continue;
    }
    requiredFrequencies.set(
      occ.required,
      (requiredFrequencies.get(occ.required) ?? 0) + 1,
    );
  }

  let baselineRequired = undefined;
  let maxReqCount = -1;
  for (const [req, count] of requiredFrequencies) {
    if (count > maxReqCount) {
      maxReqCount = count;
      baselineRequired = req;
    }
  }

  for (const occ of occurrences) {
    if (
      !sharedParameterRequiredAllowlist.has(
        `${occ.operationId}:${target.name}:${target.in}`,
      ) &&
      occ.required !== baselineRequired
    ) {
      fail(
        `shared parameter "${target.name}" in ${target.in} has required mismatch in operation "${occ.operationId}": differing field "required"`,
      );
    }
    if (JSON.stringify(sortKeys(occ.schema)) !== baselineSer) {
      const differingField = findDifferingField(occ.schema, baseline.schema);
      fail(
        `shared parameter "${target.name}" in ${target.in} has schema mismatch in operation "${occ.operationId}": differing field "${differingField}"`,
      );
    }
  }
}

// Health stays pinned by name and must stay unauthenticated. The operationId
// requirement on every other operation is what keeps an undocumented path from
// being appended to the contract: with no id it cannot appear in the manifest,
// so the agreement check below would never notice it.
if (
  document.openapi !== '3.1.1' ||
  !health ||
  health.operation?.operationId !== 'getHealth' ||
  !Array.isArray(health.operation?.security) ||
  health.operation.security.length !== 0 ||
  operations.some(({ operation }) => !operation?.operationId) ||
  // Every declared path must contribute a real operation. Without this a path
  // item holding only `description`, `parameters`, or a vendor extension adds
  // contract surface that yields no operation, so it reaches neither the
  // operationId check above nor the manifest agreement check below.
  Object.keys(document.paths ?? {}).some((declared) =>
    operations.every(({ path }) => path !== declared),
  )
) {
  fail(
    'must publish exactly GET /health with operationId getHealth and no operation security, and an operationId on every published operation',
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
// Both directions matter. A published operation absent from the manifest is
// undocumented; a manifest entry absent from the contract claims an operation
// no generated client can call. Compare as sets so entry order is free.
const canonical = (entries) =>
  JSON.stringify(
    [...entries]
      .map(({ operationId, method, path }) => ({ operationId, method, path }))
      .sort((left, right) => left.operationId.localeCompare(right.operationId)),
  );
if (
  !Array.isArray(manifest.implementedOperations) ||
  canonical(manifest.implementedOperations) !==
    canonical(
      operations.map(({ operation, method, path }) => ({
        operationId: operation.operationId,
        method,
        path,
      })),
    )
) {
  fail('manifest must list exactly the published operations');
}
if (
  provenance.executableContract?.path !== contractPath ||
  provenance.executableContract?.sha256 !== digest ||
  provenance.executableContract?.operationCount !== operations.length
) {
  fail('executable contract identity drifted');
}
const source = provenance.planningSource;
if (
  source?.revision !== '0a4c58d58b2effe2bea7a7ec2e3f0ec8d67525ca' ||
  source.path !== 'docs/savia-openapi.yaml' ||
  source.sha256 !== planningSourceSha256 ||
  source.bytes !== 160308 ||
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
