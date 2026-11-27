import {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { CLI_SCOPE_POLICY } from '../../src/platform/cli-scope-policy.js';
import { JwtAuthGuard } from '../../src/platform/jwt-auth.guard.js';
import { MCP_TOOL_ANNOTATIONS } from '../../src/mcp/mcp-tools.js';
import {
  SAVIA_SCOPES,
  type SaviaScope,
} from '../../src/platform/savia-scopes.js';

import {
  authorityMcpReads,
  bundleOpenApi,
  openapiMirror,
} from '../helpers/openapi-bundle.js';
const validScopes = new Set(Object.values(SAVIA_SCOPES));
type PolicyEntry = [string, readonly SaviaScope[]];
const routeEnvironment = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
  SAVIA_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
  CLI_DEVICE_VERIFICATION_URI: 'https://app.example.test/device',
};

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
  it('limits occurrence listing and commands to the corresponding transaction scopes', () => {
    const list = '/v1/recurring-rules/:ruleId/occurrences';
    expect(CLI_SCOPE_POLICY.get(`GET ${list}`)).toEqual(['transactions:read']);
    for (const action of ['confirm', 'skip', 'reschedule']) {
      expect(
        CLI_SCOPE_POLICY.get(`POST ${list}/:occurrenceId/${action}`),
      ).toEqual(['transactions:write']);
    }
    expect(CLI_SCOPE_POLICY.get(`PATCH ${list}/:occurrenceId`)).toEqual([
      'transactions:write',
    ]);
    expect(
      CLI_SCOPE_POLICY.get('POST /v1/recurring-rules/:ruleId/edit-series'),
    ).toEqual(['transactions:write']);
  });

  it('matches every CLI security requirement in the repository mirror', () => {
    const mirrorOperations = cliOperations(bundleOpenApi(openapiMirror));
    const expected: PolicyEntry[] = mirrorOperations
      .map(
        ({ method, path, scopes }) =>
          [`${method} ${fastifyPath(path)}`, scopes] as PolicyEntry,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    const actual: PolicyEntry[] = [...CLI_SCOPE_POLICY.entries()]
      .map(([key, scopes]) => [key, [...scopes]] as PolicyEntry)
      .sort(([left], [right]) => left.localeCompare(right));

    expect(actual).toEqual(expected);
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

  it('declares MCP admission on every implemented authority read and no other endpoint', async () => {
    const originalEnvironment = Object.fromEntries(
      Object.keys(routeEnvironment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, routeEnvironment);
    const adapter = new FastifyAdapter({ exposeHeadRoutes: false });
    const routes = new Set<string>();
    adapter.getInstance().addHook('onRoute', ({ method, url }) => {
      for (const verb of [method].flat()) routes.add(`${verb} ${url}`);
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app =
      moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    try {
      await app.init();
      const expected = new Map<string, string>();
      for (const [key, tool] of authorityMcpReads()) {
        if (!routes.has(key)) continue;
        expected.set(key, tool.name);
        expect(MCP_TOOL_ANNOTATIONS.get(tool.name)?.requiredScopes).toEqual(
          tool.requiredScopes,
        );
      }
      expect(expected.size).toBe(14);
      expect(expected.get('GET /v1/debts/:debtId/projection')).toBe(
        'get_debt_projection',
      );
      expect(expected.get('GET /v1/funds/:fundId')).toBe('get_sinking_fund');
      const actual = new Map<string, string>();
      for (const module of app.get(ModulesContainer).values()) {
        for (const entry of module.controllers.values()) {
          const type = entry.metatype;
          if (!type) continue;
          const prefix = Reflect.getMetadata(PATH_METADATA, type) as string;
          const prototype = type.prototype as Record<string, object>;
          for (const name of Object.getOwnPropertyNames(prototype)) {
            const handler = prototype[name];
            const tool = Reflect.getMetadata('savia:mcp-read', handler) as
              | { toolName: string }
              | undefined;
            if (!tool) continue;
            const guards = [
              ...(Reflect.getMetadata(GUARDS_METADATA, type) ?? []),
              ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
            ] as unknown[];
            expect(guards).toContain(JwtAuthGuard);
            const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
            const verb = Reflect.getMetadata(
              METHOD_METADATA,
              handler,
            ) as RequestMethod;
            const route = `/${[prefix, path].filter(Boolean).join('/').split('/').filter(Boolean).join('/')}`;
            const key = `${RequestMethod[verb]} ${route}`;
            expect(routes.has(key)).toBe(true);
            expect(actual.has(key)).toBe(false);
            actual.set(key, tool.toolName);
          }
        }
      }
      expect(actual).toEqual(expected);
    } finally {
      await app.close();
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
