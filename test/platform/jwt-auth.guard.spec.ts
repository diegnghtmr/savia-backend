import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '../../src/platform/jwt-auth.guard.js';

function context(authorization: string) {
  const request = { headers: { authorization } } as {
    headers: { authorization: string };
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
      }),
    };
    const guard = new JwtAuthGuard(jwt as never, cli as never);
    const pair = context('Bearer svt_opaque');
    await expect(guard.canActivate(pair.context as never)).resolves.toBe(true);
    expect(pair.request.identity).toEqual({
      subject: 'cli-subject',
      authMethod: 'cli_token',
    });
    expect(jwt.verify).not.toHaveBeenCalled();
  });
});
