import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '../../src/platform/jwt-auth.guard.js';
import {
  SAVIA_SCOPES,
  type SaviaScope,
} from '../../src/platform/savia-scopes.js';

function context(
  authorization: string,
  route = '/v1/accounts',
  method = 'GET',
) {
  const request = {
    headers: { authorization },
    method,
    routeOptions: { url: route },
  } as {
    headers: { authorization: string };
    method: string;
    routeOptions: { url: string };
    identity?: unknown;
  };
  return {
    request,
    context: { switchToHttp: () => ({ getRequest: () => request }) },
  };
}

describe('JwtAuthGuard additive CLI scheme', () => {
  it('keeps valid JWT authentication unchanged', async () => {
    const jwt = {
      verify: vi.fn().mockResolvedValue({ subject: 'jwt-subject' }),
    };
    const cli = { verify: vi.fn() };
    const guard = new JwtAuthGuard(jwt as never, cli as never);
    const pair = context('Bearer jwt-value');
    await expect(guard.canActivate(pair.context as never)).resolves.toBe(true);
    expect(pair.request.identity).toEqual({ subject: 'jwt-subject' });
    expect(cli.verify).not.toHaveBeenCalled();
  });
  it('rejects an invalid JWT without falling through to CLI', async () => {
    const jwt = { verify: vi.fn().mockRejectedValue(new Error('invalid')) };
    const cli = { verify: vi.fn() };
    const guard = new JwtAuthGuard(jwt as never, cli as never);
    await expect(
      guard.canActivate(context('Bearer invalid').context as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(cli.verify).not.toHaveBeenCalled();
  });
  it('uses the opaque scheme only for the recognizable prefix', async () => {
    const jwt = { verify: vi.fn() };
    const cli = {
      verify: vi.fn().mockResolvedValue({
        subject: 'cli-subject',
        authMethod: 'cli_token',
        scopes: [],
      }),
    };
    const guard = new JwtAuthGuard(jwt as never, cli as never);
    const pair = context('Bearer svt_opaque');
    await expect(
      guard.canActivate(pair.context as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pair.request.identity).toEqual({
      subject: 'cli-subject',
      authMethod: 'cli_token',
      scopes: [],
    });
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('fails closed for a CLI token on an unmapped route', async () => {
    const jwt = { verify: vi.fn() };
    const cli = {
      verify: vi.fn().mockResolvedValue({
        subject: 'cli-subject',
        authMethod: 'cli_token',
        scopes: [],
      }),
    };
    const guard = new JwtAuthGuard(jwt as never, cli as never);

    await expect(
      guard.canActivate(context('Bearer svt_opaque').context as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('keeps revoked or expired CLI tokens as unauthorized', async () => {
    const jwt = { verify: vi.fn() };
    const cli = { verify: vi.fn().mockRejectedValue(new Error('revoked')) };
    const guard = new JwtAuthGuard(jwt as never, cli as never);

    await expect(
      guard.canActivate(context('Bearer svt_revoked').context as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function authorizeCli(
  method: string,
  route: string,
  scopes: readonly SaviaScope[],
) {
  const jwt = { verify: vi.fn() };
  const cli = {
    verify: vi.fn().mockResolvedValue({
      subject: 'cli-subject',
      authMethod: 'cli_token',
      scopes,
    }),
  };
  const guard = new JwtAuthGuard(jwt as never, cli as never);
  return guard.canActivate(
    context('Bearer svt_opaque', route, method).context as never,
  );
}

async function expectCliForbidden(result: Promise<boolean>) {
  await expect(result).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof ForbiddenException)) return false;
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toStrictEqual({
      statusCode: 403,
      message: 'Forbidden',
    });
    return true;
  });
}

const d3Routes = [
  ['GET', '/v1/agent/conversations', 'reports:read', 'workspace:admin'],
  ['POST', '/v1/agent/conversations', 'reports:read', 'workspace:admin'],
  [
    'POST',
    '/v1/agent/conversations/:conversationId/messages',
    'reports:read',
    'workspace:admin',
  ],
  ['GET', '/v1/mcp/grants', 'workspace:admin', 'reports:read'],
  ['DELETE', '/v1/mcp/grants/:grantId', 'workspace:admin', 'reports:read'],
] as const satisfies ReadonlyArray<
  readonly [string, string, SaviaScope, SaviaScope]
>;

describe('CLI scopes for agent conversations and MCP grants', () => {
  it.each(d3Routes)('allows %s %s with %s', async (method, route, required) => {
    await expect(authorizeCli(method, route, [required])).resolves.toBe(true);
  });

  it.each(d3Routes)(
    'denies %s %s without %s',
    async (method, route, _required, wrongScope) => {
      await expectCliForbidden(authorizeCli(method, route, [wrongScope]));
    },
  );

  it.each([
    ['POST', '/v1/mcp/grants'],
    ['GET', '/v1/ai/credentials'],
    ['POST', '/v1/ai/credentials'],
    ['PATCH', '/v1/ai/credentials/:id'],
    ['DELETE', '/v1/ai/credentials/:id'],
    ['PUT', '/v1/ai/default-model'],
    ['GET', '/v1/approvals/:approvalId'],
    ['POST', '/v1/approvals/:approvalId/confirm'],
    ['POST', '/v1/approvals/:approvalId/reject'],
  ])('keeps %s %s unavailable to CLI tokens', async (method, route) => {
    await expectCliForbidden(
      authorizeCli(method, route, Object.values(SAVIA_SCOPES)),
    );
  });
});
