import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const verifier = resolve(root, 'scripts/verify-openapi.mjs');

/**
 * The contract authority (docs/savia-openapi.yaml) lives in the PARENT savia-general
 * repository, which is deliberately never published (ADR-0017). A standalone CI checkout
 * of savia-backend therefore does not have it, so the authority comparison below can only
 * run on a nested developer checkout, or when SAVIA_OPENAPI_AUTHORITY points at it.
 *
 * The skip is announced on purpose. A silent skip would recreate exactly the invisible
 * mirror drift this comparison exists to catch. The internal shared-parameter consistency
 * guard in scripts/verify-openapi.mjs needs no authority and DOES run in CI.
 */
const authorityPath =
  process.env.SAVIA_OPENAPI_AUTHORITY ??
  resolve(root, '../../docs/savia-openapi.yaml');
const authorityAvailable = existsSync(authorityPath);

if (!authorityAvailable) {
  console.warn(
    `[openapi-authority] Skipping the mirror-versus-authority comparison: ${authorityPath} does not exist. ` +
      'Run this suite from a checkout nested beside savia-general, or set SAVIA_OPENAPI_AUTHORITY.',
  );
}
const testRoot = mkdtempSync(resolve(tmpdir(), 'savia-openapi-authority-'));
const contract = resolve(testRoot, 'openapi/savia.openapi.yaml');
const provenance = resolve(testRoot, 'openapi/provenance.json');
const manifest = resolve(testRoot, 'openapi/implementation-manifest.json');
const readme = resolve(testRoot, 'README.md');
const planningSnapshot = resolve(
  testRoot,
  'openapi/planning-reference.snapshot.yaml',
);

cpSync(resolve(root, 'openapi'), resolve(testRoot, 'openapi'), {
  recursive: true,
});
cpSync(resolve(root, 'README.md'), readme);

const originals = new Map(
  [contract, provenance, manifest, readme].map((path) => [
    path,
    readFileSync(path, 'utf8'),
  ]),
);
const verify = () =>
  execFileSync(process.execPath, [verifier], {
    cwd: root,
    env: { ...process.env, OPENAPI_AUTHORITY_ROOT: testRoot },
  }).toString();

afterEach(() => {
  for (const [path, content] of originals) writeFileSync(path, content);
  rmSync(planningSnapshot, { force: true });
});

describe('executable OpenAPI authority', () => {
  it('verifies the sole published health operation', () => {
    expect(existsSync(resolve(root, 'openapi/savia.openapi.yaml'))).toBe(true);
    expect(existsSync(verifier)).toBe(true);
    expect(verify()).toContain('OpenAPI authority verified.');
  });

  it('rejects planning provenance constant drift', () => {
    const metadata = JSON.parse(readFileSync(provenance, 'utf8'));
    metadata.planningSource.operationCount = 92;
    writeFileSync(provenance, `${JSON.stringify(metadata, null, 2)}\n`);

    expect(verify).toThrow(/planning-source constants drifted/);
  });

  it('rejects a copied planning source snapshot', () => {
    writeFileSync(planningSnapshot, 'openapi: 3.1.1\npaths: {}\n');

    expect(verify).toThrow(/planning source must not be copied/);
  });

  it.each([
    [
      'provenance',
      provenance,
      (content: string) => content.replace('cannot access', 'can access'),
    ],
    [
      'README',
      readme,
      (content: string) =>
        content.replace(
          'cannot access, authenticate, or independently\nre-hash',
          'can access, authenticate, or independently\nre-hash',
        ),
    ],
    [
      'manifest',
      manifest,
      (content: string) =>
        content.replace(
          '{\n',
          '{\n  "planningSourceVerification": "Backend CI can authenticate local source",\n',
        ),
    ],
  ])(
    'rejects a false CI source-verification claim in %s',
    (_artifact, path, mutate) => {
      writeFileSync(path, mutate(readFileSync(path, 'utf8')));

      expect(verify).toThrow(
        /backend CI must not claim local planning-source verification/,
      );
    },
  );

  it('rejects every additional OpenAPI path or HTTP operation without operationId', () => {
    writeFileSync(
      contract,
      `${readFileSync(contract, 'utf8')}\n  /internal:\n    post:\n      responses:\n        '204':\n          description: Hidden operation\n`,
    );

    expect(verify).toThrow(/must publish exactly GET \/health/);
  });

  it('publishes the complete reconciliation transport response set', () => {
    const source = readFileSync(contract, 'utf8');
    const operation = source.slice(
      source.indexOf('operationId: completeReconciliation'),
      source.indexOf(
        '  /v1/reconciliations/{reconciliationId}:',
        source.indexOf('operationId: completeReconciliation'),
      ),
    );
    const codes = [...operation.matchAll(/^( {8})'(\d{3})':/gm)].map(
      (match) => match[2],
    );
    expect(codes).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '422',
      '500',
    ]);
  });

  it.skipIf(!authorityAvailable)(
    'mirrors budget response schemas and MCP OAuth scopes semantically',
    () => {
      const bundle = (path: string) => {
        const directory = mkdtempSync(
          resolve(tmpdir(), 'savia-openapi-semantic-'),
        );
        const output = resolve(directory, 'contract.json');
        try {
          execFileSync(
            resolve(root, 'node_modules/.bin/redocly'),
            ['bundle', path, '--ext', 'json', '--output', output],
            { cwd: root, stdio: 'pipe' },
          );
          return JSON.parse(readFileSync(output, 'utf8')) as Record<
            string,
            unknown
          >;
        } finally {
          rmSync(directory, { force: true, recursive: true });
        }
      };
      const authority = bundle(authorityPath);
      const mirror = bundle(resolve(root, 'openapi/savia.openapi.yaml'));
      const pick = (document: Record<string, unknown>) => {
        const paths = document.paths as Record<
          string,
          Record<string, Record<string, unknown>>
        >;
        const schemas = document.components as Record<
          string,
          Record<string, unknown>
        >;
        const responseContent = (responses: unknown) =>
          Object.fromEntries(
            Object.entries(
              (responses ?? {}) as Record<string, Record<string, unknown>>,
            )
              .filter(([, response]) => response.content !== undefined)
              .map(([status, response]) => [status, response.content]),
          );
        return {
          list: responseContent(paths['/v1/budgets']?.get?.responses),
          create: responseContent(paths['/v1/budgets']?.post?.responses),
          get: responseContent(paths['/v1/budgets/{budgetId}']?.get?.responses),
          oauth: (schemas.securitySchemes?.mcpOAuth as Record<string, unknown>)
            ?.flows,
        };
      };
      expect(pick(mirror)).toEqual(pick(authority));
    },
  );

  it('rejects shared parameter schema drift across operations', () => {
    writeFileSync(
      contract,
      readFileSync(contract, 'utf8').replace(
        'schema: { type: integer, minimum: 1, maximum: 200, default: 50 }',
        'schema: { type: integer, minimum: 1, maximum: 200 }',
      ),
    );

    expect(verify).toThrow(
      /shared parameter "limit" in query has schema mismatch in operation "listBudgets": differing field "default"/,
    );
  });
});
