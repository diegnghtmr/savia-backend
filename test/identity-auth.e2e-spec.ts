import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { AuthConfig } from '../src/identity/auth-config.js';
import type { AuthenticatedRequest } from '../src/identity/authenticated-request.js';
import { IdentityModule } from '../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../src/identity/jose-jwt-verifier.js';
import { JwtAuthGuard } from '../src/identity/jwt-auth.guard.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import { createJwksServer, type JwksServer } from './helpers/jwks-server.js';

const authEnvironment = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
  DATABASE_URL: 'postgresql://user:secret@unreachable.invalid:5432/savia',
};
const authEnvironmentKeys = Object.keys(authEnvironment);
let originalEnvironment: Record<string, string | undefined>;
let server: JwksServer | undefined;

@Controller('test')
class IdentityHarnessController {
  @Get('identity')
  @UseGuards(JwtAuthGuard)
  identity(@Req() request: AuthenticatedRequest) {
    return request.identity;
  }
}

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    authEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, authEnvironment);
});

afterEach(async () => {
  for (const key of authEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await server?.close();
  server = undefined;
});

async function createApplication(
  verifier?: JoseJwtVerifier,
): Promise<NestFastifyApplication> {
  const builder = Test.createTestingModule({
    imports: verifier === undefined ? [AppModule] : [IdentityModule],
    controllers: verifier === undefined ? [] : [IdentityHarnessController],
  });
  if (verifier !== undefined) {
    builder.overrideProvider(JoseJwtVerifier).useValue(verifier);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('identity HTTP boundary', () => {
  it('establishes identity only from a verified bearer token', async () => {
    const signingKey = await generateKeyPair('RS256');
    const publicKey = Object.assign(await exportJWK(signingKey.publicKey), {
      kid: 'key-1',
      alg: 'RS256',
      use: 'sig',
    });
    server = await createJwksServer({
      kind: 'jwks',
      body: { keys: [publicKey] },
    });
    const verifier = new JoseJwtVerifier(
      AuthConfig.fromEnvironment(authEnvironment),
      { fetch: (_input, init) => fetch(server?.uri ?? '', init) },
    );
    const token = await new SignJWT({
      iss: authEnvironment.JWT_ISSUER,
      aud: authEnvironment.JWT_AUDIENCE,
      sub: 'subject-123',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .sign(signingKey.privateKey);
    const app = await createApplication(verifier);

    const response = await app.inject({
      method: 'GET',
      url: '/test/identity',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ subject: 'subject-123' });
    await app.close();
  });

  it.each([undefined, 'Basic token', 'Bearer', 'Bearer not-a-jwt'])(
    'returns a sanitized 401 for an invalid authorization header: %s',
    async (authorization) => {
      const app = await createApplication(
        new JoseJwtVerifier(AuthConfig.fromEnvironment(authEnvironment)),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/test/identity',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.payload)).toEqual({
        code: 'unauthorized',
        instance: '/test/identity',
        status: 401,
        title: 'Authentication is required',
        traceId: expect.stringMatching(/.+/),
        type: 'https://savia.app/problems/unauthorized',
      });
      await app.close();
    },
  );

  it('fails before serving requests when auth configuration is missing', async () => {
    delete process.env.JWT_ISSUER;

    await expect(createApplication()).rejects.toThrow(/JWT configuration/i);
  });
});
