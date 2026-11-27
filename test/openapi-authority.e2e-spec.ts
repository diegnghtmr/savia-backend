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
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MCP_TOOL_ANNOTATIONS } from '../src/mcp/mcp-tools.js';
import { bundleOpenApi, openapiMirror } from './helpers/openapi-bundle.js';

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

type SharedParameter = {
  required?: boolean;
  schema: { default?: number };
};

type Operation = {
  responses: Record<string, unknown>;
  parameters: (SharedParameter | { $ref: string })[];
};

type BundledMirror = {
  paths: Record<string, Record<string, Operation>>;
  components: { parameters: Record<string, SharedParameter> };
};

let bundledMirror: BundledMirror | undefined;
function mirrorDocument(): BundledMirror {
  bundledMirror ??= bundleOpenApi(openapiMirror) as BundledMirror;
  return structuredClone(bundledMirror);
}

function mutateParameter(
  path: string,
  component: 'Cursor' | 'Limit',
  change: (parameter: SharedParameter) => void,
): void {
  const document = mirrorDocument();
  const parameters = document.paths[path].get.parameters;
  const reference = `#/components/parameters/${component}`;
  const index = parameters.findIndex(
    (p) => '$ref' in p && p.$ref === reference,
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const override = structuredClone(document.components.parameters[component]);
  change(override);
  parameters.splice(index, 1, override);
  writeFileSync(contract, JSON.stringify(document));
}

afterEach(() => {
  for (const [path, content] of originals) writeFileSync(path, content);
  rmSync(planningSnapshot, { force: true });
});
afterAll(() => rmSync(testRoot, { force: true, recursive: true }));

describe('executable OpenAPI authority', () => {
  it('verifies the published executable contract', { timeout: 30_000 }, () => {
    expect(existsSync(openapiMirror)).toBe(true);
    expect(existsSync(verifier)).toBe(true);
    expect(verify()).toContain('OpenAPI authority verified.');
  });

  it('rejects a declared bare 500 response', { timeout: 30_000 }, () => {
    const document = mirrorDocument();
    document.paths['/health'].get.responses['500'] = {
      description: 'Injected bare 500.',
    };
    writeFileSync(contract, JSON.stringify(document));

    expect(verify).toThrow(/bare 500/);
  });

  it('rejects planning provenance constant drift', { timeout: 30_000 }, () => {
    const metadata = JSON.parse(readFileSync(provenance, 'utf8'));
    metadata.planningSource.operationCount = 92;
    writeFileSync(provenance, `${JSON.stringify(metadata, null, 2)}\n`);

    expect(verify).toThrow(/planning-source constants drifted/);
  });

  it('rejects a copied planning source snapshot', { timeout: 30_000 }, () => {
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
    30_000,
  );

  it(
    'rejects every additional OpenAPI path or HTTP operation without operationId',
    { timeout: 30_000 },
    () => {
      writeFileSync(
        contract,
        `${readFileSync(contract, 'utf8')}\n  /internal:\n    post:\n      responses:\n        '204':\n          description: Hidden operation\n`,
      );

      expect(verify).toThrow(/must publish exactly GET \/health/);
    },
  );

  it('publishes the complete reconciliation transport response set', () => {
    const { paths } = mirrorDocument();
    const codes = Object.keys(
      paths['/v1/reconciliations/{reconciliationId}/complete'].post.responses,
    ).sort();
    expect(codes).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '422',
      '503',
    ]);
  });

  it.skipIf(!authorityAvailable)(
    'mirrors backup, funds, notification settings, budget responses, and MCP grants, proposals, OAuth and annotations',
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
      const pathsOf = (document: Record<string, unknown>) =>
        document.paths as Record<
          string,
          Record<string, Record<string, unknown>>
        >;
      const pick = (document: Record<string, unknown>) => {
        const paths = pathsOf(document);
        const confirm = paths['/v1/approvals/{approvalId}/confirm']?.post;
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
        const fundOperations = (path: string) =>
          Object.fromEntries(
            Object.entries(paths[path] ?? {}).map(([method, operation]) => {
              if (method === 'parameters') return [method, operation];
              const contract = { ...operation };
              delete contract['x-idempotency-required'];
              return [method, contract];
            }),
          );
        return {
          funds: fundOperations('/v1/funds/{fundId}'),
          withdrawals: fundOperations('/v1/funds/{fundId}/withdrawals'),
          fundSchemas: [
            'Fund',
            'FundDetail',
            'UpdateFundRequest',
            'PositiveFundAmount',
            'CreateFundWithdrawalRequest',
          ].map((name) => schemas.schemas?.[name]),
          fundTag: schemas.headers?.ETag,
          list: responseContent(paths['/v1/budgets']?.get?.responses),
          create: responseContent(paths['/v1/budgets']?.post?.responses),
          get: responseContent(paths['/v1/budgets/{budgetId}']?.get?.responses),
          backupCreate: paths['/v1/backup-jobs'],
          backupPoll: paths['/v1/backup-jobs/{backupJobId}'],
          backupSchema: schemas.schemas?.WorkspaceBackupJob,
          notificationPreferences: paths['/v1/me/notification-preferences'],
          pushDevices: paths['/v1/me/push-devices'],
          pushDevice: paths['/v1/me/push-devices/{deviceId}'],
          notificationSchemas: [
            'NotificationPreferences',
            'NotificationQuietHours',
            'NotificationLocalTime',
            'RegisterPushDeviceRequest',
            'PushDeviceRegistration',
          ].map((name) => schemas.schemas?.[name]),
          proposal: paths['/v1/mcp/proposals']?.post,
          confirmDescription: confirm?.description,
          confirmationPrecondition: (
            confirm?.responses as Record<string, unknown>
          )?.['412'],
          mcpOAuth: schemas.securitySchemes?.mcpOAuth,
          grantSchemas: Object.fromEntries(
            [
              'CreateMcpGrantRequest',
              'CreateMcpProposalRequest',
              'McpProposalApproval',
              'McpGrant',
              'McpGrantSchedule',
              'McpToolAllowlist',
              'McpToolName',
              'McpWeeklyWindow',
              'SaviaScope',
            ].map((name) => [name, schemas.schemas?.[name]]),
          ),
        };
      };
      expect(pick(mirror)).toEqual(pick(authority));
      const authorityPaths = pathsOf(authority);
      const annotations: [string, Record<string, unknown>][] = [];
      for (const [path, item] of Object.entries(pathsOf(mirror))) {
        for (const [method, operation] of Object.entries(item)) {
          if (typeof operation?.operationId !== 'string') continue;
          const source = authorityPaths[path]?.[method];
          expect(source?.operationId).toBe(operation.operationId);
          const tool = source?.['x-savia-mcp-tool'] as
            | ({ name: string } & Record<string, unknown>)
            | undefined;
          if (operation['x-savia-mcp-tool'] !== undefined) {
            expect(operation['x-savia-mcp-tool']).toEqual(tool);
          }
          if (tool) {
            const { name, ...annotation } = tool;
            annotations.push([name, annotation]);
          }
        }
      }
      expect(annotations).toHaveLength(MCP_TOOL_ANNOTATIONS.size);
      expect(Object.fromEntries(MCP_TOOL_ANNOTATIONS)).toEqual(
        Object.fromEntries(annotations),
      );
    },
    30_000,
  );

  it(
    'rejects shared parameter schema drift across operations',
    { timeout: 30_000 },
    () => {
      mutateParameter('/v1/budgets', 'Limit', (parameter) => {
        delete parameter.schema.default;
      });

      expect(verify).toThrow(
        /shared parameter "limit" in query has schema mismatch in operation "listBudgets": differing field "default"/,
      );
    },
  );

  it(
    'rejects shared parameter required drift across operations',
    { timeout: 30_000 },
    () => {
      mutateParameter('/v1/workspaces', 'Cursor', (parameter) => {
        delete parameter.required;
      });

      expect(verify).toThrow(
        /shared parameter "cursor" in query has required mismatch in operation "listWorkspaces": differing field "required"/,
      );
    },
  );

  it('mirrors the read-only debt projection MCP tool from the pinned authority', () => {
    const section = (path: string) =>
      readFileSync(path, 'utf8').match(
        /^ {2}\/v1\/debts\/\{debtId\}\/projection:\n([\s\S]*?)(?=^ {2}\/|^components:)/m,
      )?.[1];
    const annotation = (path: string) =>
      section(path)
        ?.match(/^ {6}x-savia-mcp-tool:\n((?:^ {8}[^\n]+\n)+)/m)?.[1]
        .replaceAll(/^\s+/gm, '');
    const expected =
      'name: get_debt_projection\nriskClass: read\nrequiresApproval: false\nrequiredScopes:\n- budgets:read\n';
    if (authorityAvailable) expect(annotation(authorityPath)).toBe(expected);
    expect(annotation(contract)).toBe(expected);
  });
});
