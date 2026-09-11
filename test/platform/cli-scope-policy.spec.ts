import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { CLI_SCOPE_POLICY } from '../../src/platform/cli-scope-policy.js';
import {
  SAVIA_SCOPES,
  type SaviaScope,
} from '../../src/platform/savia-scopes.js';

const root = process.cwd();
const authority = resolve(root, '../../docs/savia-openapi.yaml');
const mirror = resolve(root, 'openapi/savia.openapi.yaml');
const validScopes = new Set(Object.values(SAVIA_SCOPES));
const routeEnvironment = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
  SAVIA_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
  CLI_DEVICE_VERIFICATION_URI: 'https://app.example.test/device',
};

function bundle(path: string): Record<string, unknown> {
  const directory = mkdtempSync(resolve(tmpdir(), 'savia-cli-scope-'));
  const output = resolve(directory, 'contract.json');
  try {
    execFileSync(
      resolve(root, 'node_modules/.bin/redocly'),
      ['bundle', path, '--ext', 'json', '--output', output],
      { cwd: root, stdio: 'pipe' },
    );
    return JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function cliOperations(document: Record<string, unknown>) {
  const paths = document.paths as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(method),
      )
      .flatMap(([method, operation]) => {
        const security = operation.security as
          | Array<Record<string, SaviaScope[]>>
          | undefined;
        const cli = security?.find((requirement) => requirement.cliTokenAuth);
        return cli === undefined
          ? []
          : [
              {
                operationId: operation.operationId,
                method: method.toUpperCase(),
                path,
                scopes: cli.cliTokenAuth,
              },
            ];
      }),
  );
}

function fastifyPath(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

describe('CLI scope policy parity', () => {
  it('matches every CLI security requirement in the authority', () => {
    const authorityOperations = cliOperations(bundle(authority));
    const mirrorOperations = cliOperations(bundle(mirror));
    const expected = authorityOperations
      .map(({ method, path, scopes }) => [
        `${method} ${fastifyPath(path)}`,
        scopes,
      ])
      .sort(([left], [right]) => left.localeCompare(right));
    const mirrored = mirrorOperations
      .map(({ method, path, scopes }) => [
        `${method} ${fastifyPath(path)}`,
        scopes,
      ])
      .sort(([left], [right]) => left.localeCompare(right));
    const actual = [...CLI_SCOPE_POLICY.entries()]
      .map(([key, scopes]) => [key, [...scopes]])
      .sort(([left], [right]) => left.localeCompare(right));

    expect(actual).toEqual(expected);
    expect(mirrored).toEqual(expected);
    expect(
      actual.every(([, scopes]) =>
        scopes.every((scope) => validScopes.has(scope as SaviaScope)),
      ),
    ).toBe(true);
  });

  it('keeps every policy key in the implemented Fastify route table', async () => {
    const originalEnvironment = Object.fromEntries(
      Object.keys(routeEnvironment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, routeEnvironment);
    delete process.env.DATABASE_URL;

    const routes: string[] = [];
    const adapter = new FastifyAdapter({ exposeHeadRoutes: false });
    adapter.getInstance().addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      routes.push(...methods.map((method) => `${method} ${route.url}`));
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app =
      moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      for (const key of CLI_SCOPE_POLICY.keys()) expect(routes).toContain(key);
    } finally {
      await app.close();
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
